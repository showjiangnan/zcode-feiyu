// Modified by ZCode Feiyu.
import ts from "typescript";
import type { WorkflowProgram } from "../compiler/compile.js";
import type { HoleSite, IterationCandidate, SiteTable } from "./sites.js";
import {
  addPlaceholder,
  emptyValue,
  mergeInto,
  type AbstractValue,
  type Placeholder,
  type TaintFacts,
  type TaintOcc,
} from "./domain.js";
import { findWorkflowBody } from "./domain.js";
import { taintStateBuildLookups, taintStateCollectFunctions } from "./state-discovery.js";
import {
  taintStateEnvSlot,
  taintStateSummaryOf,
  taintStateInstanceOf,
  taintStateJoinResultOf,
  taintStateCondPlaceOf,
  taintStateLiteralPlaceOf,
} from "./state-places.js";
import {
  taintStateEmitFacts,
  taintStateEmitOracle,
  taintStateResolveArtifact,
  taintStateResolveActor,
  taintStateResolveOccs,
  taintStateResolvePlaceholders,
  taintStateResolvePlaceholder,
} from "./state-emission.js";

/**
 * The mutable fixpoint state of the taint pass: the site lookups, the global
 * environment, function summaries, the reachability/promotion sets, and the sink
 * accumulators. The evaluator (taint.ts) drives it; this module owns the storage,
 * the monotone update primitives (each reports growth via `changed`), and the final
 * placeholder-resolving emission of {@link TaintFacts}.
 */
/** How a function reached a call site: as the thing called, or as an argument a library may invoke. */
export type ApplicationVia = "callee" | "argument";

export class TaintState {
  readonly checker: ts.TypeChecker;
  readonly program: ts.Program;
  readonly scriptFile: ts.SourceFile;
  readonly body: ts.Block;

  // Site lookups keyed by their raw AST nodes (the table resolved them via the checker).
  readonly askByCall = new Map<ts.CallExpression, string>();
  readonly askSites = new Map<
    string,
    { receiver: ts.Expression; instructions: ts.Expression | undefined }
  >();
  readonly worldByCall = new Map<
    ts.CallExpression,
    { id: string; args: readonly ts.Expression[] }
  >();
  readonly joinByCall = new Map<
    ts.CallExpression,
    { id: string; arg: ts.Expression | undefined }
  >();
  readonly actorByCall = new Map<ts.CallExpression, string>();
  /** 留白调用 → 站点（开放与已补全都在；transfer 规则按有无 body 分派）。 */
  readonly holeByCall = new Map<ts.CallExpression, HoleSite>();
  /** Per-element callback calls (`xs.map(fn)`, `Array.from(xs, fn)`, …), keyed by the CALL. */
  readonly candByCall = new Map<ts.CallExpression, IterationCandidate>();
  readonly candByForOf = new Map<ts.Node, IterationCandidate>();
  /**
   * THE CALL ORACLE: for every call / `new` /
   * tagged-template node, the script-local functions this pass applied there and HOW —
   * `callee` (the node's callee value held the function: direct call, through a parameter,
   * a field, a class member) or `argument` (the node handed the function to a library callee
   * that may invoke it: a registry entry or the keystone rule). Monotone like every other
   * accumulator; read after convergence by the ordering walk, which inlines exactly these
   * bodies at exactly these sites instead of guessing from syntax.
   */
  readonly applications = new Map<ts.Node, Map<ts.Node, ApplicationVia>>();
  /**
   * The live abstract result of each `Promise.all` join call, keyed by the join CALL NODE
   * and PERSISTENT across fixpoint passes (see {@link joinResultOf}). A join result IS a
   * place whose element fields carry may-alias back-references to the (place) inputs, so
   * resolvePlace returns it — letting `const [a, b] = await Promise.all([…])`
   * destructure-alias the elements and a write through `res[k]` reach the original input.
   */
  readonly joinResults = new Map<ts.CallExpression, AbstractValue>();
  /**
   * The live abstract place of each conditional expression used as a place
   * (`flag ? box1 : box2`), keyed by the ConditionalExpression NODE and persistent across
   * passes (see {@link condPlaceOf}). Same canonical-heap requirement as {@link joinResults}.
   */
  readonly condPlaces = new Map<ts.ConditionalExpression, AbstractValue>();
  /** Allocation-site places of container literals; see {@link literalPlaceOf}. */
  readonly literalPlaces = new Map<
    ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
    AbstractValue
  >();

  // Script-local functions (excluding iteration callbacks, handled inline).
  readonly fnId = new Map<ts.Node, number>();
  readonly fnParamSymbols = new Map<number, (ts.Symbol | undefined)[]>();
  readonly functions: ts.Node[] = [];
  readonly callbackNodes = new Set<ts.Node>();
  /**
   * Object-literal set accessors, keyed by property name -> setter fn ids. Crude but
   * sound: an assignment to ANY property of that name (on any object) records the
   * assigned value as the setter's param-0 actual, so the setter body's flow is seen.
   */
  readonly settersByProp = new Map<string, number[]>();

  /**
   * One shared abstract instance per class declaration/expression, keyed by the class
   * node. Static AND instance members conflate into this ONE value (a deliberate sound
   * over-approximation: per-instance and static/instance precision are out of scope, so
   * a write through any instance, through `this`, or through the class name is visible
   * through every other). Persistent across fixpoint passes — growth is signalled like
   * any env slot.
   */
  readonly classInstances = new Map<ts.Node, AbstractValue>();
  /** Class declarations/expressions in the workflow body, in discovery order. */
  readonly classes: ts.Node[] = [];

  // Persistent fixpoint state.
  readonly env = new Map<ts.Symbol, AbstractValue>();
  readonly summaries = new Map<number, AbstractValue>();
  readonly paramActuals = new Map<string, AbstractValue>();
  /**
   * Per-placeholder-parameter set of values that MAY be passed to an INVOCATION of that
   * parameter (keyed by `${fnId}:${param}`). Two capture sites (calls.ts handleUnknownCall):
   * a direct call of a placeholder callee (`resolve(draft)` — resolve is param 0), and a
   * placeholder-valued argument to an unknown call (`draft.then(onOk)` — the unknown `.then`
   * may invoke onOk with the receiver pot). Consumed by the promise machinery: `new
   * Unknown(fn)` and `await thenable` resolve to whatever fn's / then's callback params
   * receive (the resolve/reject/continuation pattern). Distinct from {@link paramActuals},
   * which records what a function receives when IT is called.
   */
  readonly phCallActuals = new Map<string, AbstractValue>();
  readonly reachSet = new Set<string>();
  readonly calledFns = new Map<string, Set<number>>();
  readonly promotedOrders = new Set<number>();
  /**
   * Per-`reduce`-candidate accumulator taint (keyed by candidate `order`), carried
   * ACROSS fixpoint passes. The callback-return value that reduce threads into the
   * accumulator param is a fresh local each pass, so binding the param from it
   * directly never observed the return taint; this persistent slot fixes that.
   */
  readonly reduceAcc = new Map<number, AbstractValue>();

  // Sink accumulators (may contain placeholders; resolved at emission).
  readonly askInstr = new Map<string, AbstractValue>();
  readonly askRecv = new Map<string, AbstractValue>();
  readonly worldRead = new Map<string, AbstractValue>();
  /** 开放留白的提示 sink（docs/analysis.md「Sites」：提示流入留白，如 ask 的 instructions）。 */
  readonly holePrompt = new Map<string, AbstractValue>();
  readonly joinInByPort = new Map<string, Map<number, AbstractValue>>();
  readonly fanoutInVal = new Map<string, AbstractValue>();
  /**
   * The ORACLE accumulators, keyed by source START OFFSET rather than by site id: the
   * value each `await` operand carries, and the value each guard expression reads. They
   * feed {@link emitOracle}, which only the temporal walk (causality-order.ts) consumes —
   * nothing here changes a transfer rule, and a position keys nothing in the site
   * vocabulary, which is what keeps the site-id stability rule untouched: no `order`
   * counter and no per-kind counter is consulted.
   */
  readonly awaitVal = new Map<number, AbstractValue>();
  readonly guardVal = new Map<number, AbstractValue>();
  readonly returnVal = emptyValue();
  /**
   * One script-global thrown-value set: every `throw` joins its operand into it and
   * every `catch` binding reads all of it. A flow-insensitive over-approximation of
   * exception routing — sound under gen-only, deliberately imprecise across disjoint
   * `try` blocks. Persistent across passes so throws in one iteration reach catches
   * in the next (fixpoint-safe).
   */
  readonly thrownVal = emptyValue();

  changed = false;

  constructor(
    workflow: WorkflowProgram,
    readonly table: SiteTable,
  ) {
    this.checker = workflow.program.getTypeChecker();
    this.program = workflow.program;
    this.scriptFile = workflow.scriptFile;
    this.body = findWorkflowBody(workflow.scriptFile);
    this.buildLookups();
    this.collectFunctions();
  }
  private buildLookups(): void {
    return taintStateBuildLookups.call(this);
  }

  private collectFunctions(): void {
    return taintStateCollectFunctions.call(this);
  }

  // -- monotone update primitives ------------------------------------------

  /**
   * Bind a symbol to an abstract value. A FRESH symbol ADOPTS the value object by
   * reference (`env[sym] === value`); an already-bound slot weak-merges (sound smear).
   * Adoption is what makes bindings alias rather than snapshot: passing a live place (env slot / live field) shares it, so a later
   * write through any alias is visible through every other. Callers that must NOT
   * alias pass a fresh clone/collapse (reads already return snapshots).
   */
  bindSymbol(sym: ts.Symbol, value: AbstractValue): void {
    const existing = this.env.get(sym);
    if (existing === undefined) {
      this.env.set(sym, value);
      this.changed = true;
      return;
    }
    if (existing !== value && mergeInto(existing, value)) this.changed = true;
  }
  envSlot(sym: ts.Symbol): AbstractValue {
    return taintStateEnvSlot.call(this, sym);
  }

  summaryOf(id: number): AbstractValue {
    return taintStateSummaryOf.call(this, id);
  }

  instanceOf(cls: ts.Node): AbstractValue {
    return taintStateInstanceOf.call(this, cls);
  }

  joinResultOf(call: ts.CallExpression): AbstractValue {
    return taintStateJoinResultOf.call(this, call);
  }

  condPlaceOf(node: ts.ConditionalExpression): AbstractValue {
    return taintStateCondPlaceOf.call(this, node);
  }

  literalPlaceOf(
    node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
    fresh: AbstractValue,
  ): AbstractValue {
    return taintStateLiteralPlaceOf.call(this, node, fresh);
  }

  mergeReturn(value: AbstractValue): void {
    if (mergeInto(this.returnVal, value)) this.changed = true;
  }

  /** Join a thrown operand into the script-global thrown-value set. */
  mergeThrown(value: AbstractValue): void {
    if (mergeInto(this.thrownVal, value)) this.changed = true;
  }

  /**
   * Weak-merge into a keyed sink accumulator. Generic in the key so the oracle
   * accumulators ({@link awaitVal} / {@link guardVal}), which are keyed by source offset
   * rather than site id, share the one monotone update path every other sink uses.
   */
  mergeSink<K>(map: Map<K, AbstractValue>, id: K, value: AbstractValue): void {
    let slot = map.get(id);
    if (slot === undefined) {
      slot = emptyValue();
      map.set(id, slot);
    }
    if (mergeInto(slot, value)) this.changed = true;
  }

  mergeJoinIn(id: string, port: number, value: AbstractValue): void {
    let ports = this.joinInByPort.get(id);
    if (ports === undefined) {
      ports = new Map();
      this.joinInByPort.set(id, ports);
    }
    let slot = ports.get(port);
    if (slot === undefined) {
      slot = emptyValue();
      ports.set(port, slot);
    }
    if (mergeInto(slot, value)) this.changed = true;
  }

  addParamActual(id: number, param: number, value: AbstractValue): void {
    const key = `${id}:${param}`;
    let slot = this.paramActuals.get(key);
    if (slot === undefined) {
      slot = emptyValue();
      this.paramActuals.set(key, slot);
    }
    if (mergeInto(slot, value)) this.changed = true;
  }

  /** Record a value that may reach an invocation of the placeholder-parameter `key`. */
  recordPhCall(key: string, value: AbstractValue): void {
    let slot = this.phCallActuals.get(key);
    if (slot === undefined) {
      slot = emptyValue();
      this.phCallActuals.set(key, slot);
    }
    if (mergeInto(slot, value)) this.changed = true;
  }

  /** The taint fed to invocations of a function's parameter `param`, if any. */
  phCallActualsOf(id: number, param: number): AbstractValue | undefined {
    return this.phCallActuals.get(`${id}:${param}`);
  }

  /** The persistent accumulator taint for a `reduce` candidate (empty until seeded). */
  reduceAccOf(order: number): AbstractValue {
    let slot = this.reduceAcc.get(order);
    if (slot === undefined) {
      slot = emptyValue();
      this.reduceAcc.set(order, slot);
    }
    return slot;
  }

  /** Merge a pass's callback-return taint into a `reduce` candidate's accumulator. */
  mergeReduceAcc(order: number, value: AbstractValue): void {
    if (mergeInto(this.reduceAccOf(order), value)) this.changed = true;
  }

  /**
   * Record a call against EVERY enclosing region, mirroring {@link markFacade}.
   * Recording only the innermost region left a caller function `fn@f`
   * unmarked when its call to `g` happened inside an iteration candidate's callback
   * (region `cand@N`). Reachability then never propagated `fn@f`, so a sibling
   * candidate whose callback calls `f` failed to promote to a fan-out — an
   * under-approximation (a dropped may-flow), which this analysis must never do.
   */
  markCalled(regionStack: string[], id: number): void {
    for (const region of regionStack) {
      let called = this.calledFns.get(region);
      if (called === undefined) {
        called = new Set();
        this.calledFns.set(region, called);
      }
      if (!called.has(id)) {
        called.add(id);
        this.changed = true;
      }
    }
  }

  /** Record that `fn` was applied at `site` (see {@link applications}). Not a fixpoint
   * signal: applications feed no transfer rule, and the final pass re-records them all. */
  recordApplication(site: ts.Node, fn: ts.Node, via: ApplicationVia): void {
    let applied = this.applications.get(site);
    if (applied === undefined) {
      applied = new Map();
      this.applications.set(site, applied);
    }
    // `callee` wins over `argument` for one function at one site (both can happen for a
    // function passed to itself; the callee reading is the one that surely runs).
    if (applied.get(fn) !== "callee") applied.set(fn, via);
  }

  /** Mark every enclosing region as reaching a facade site. */
  markFacade(regionStack: string[]): void {
    for (const region of regionStack) {
      if (!this.reachSet.has(region)) {
        this.reachSet.add(region);
        this.changed = true;
      }
    }
  }

  /** Propagate reachability across the call graph until it stops growing. */
  propagateReachability(): void {
    let grew = true;
    while (grew) {
      grew = false;
      for (const [region, fns] of this.calledFns) {
        if (this.reachSet.has(region)) continue;
        for (const id of fns) {
          if (this.reachSet.has(`fn@${id}`)) {
            this.reachSet.add(region);
            this.changed = true;
            grew = true;
            break;
          }
        }
      }
    }
  }

  /** Promote iteration candidates whose body region reaches a facade site. */
  recomputePromotion(): void {
    for (const cand of this.table.iterations) {
      if (this.promotedOrders.has(cand.order)) continue;
      if (this.reachSet.has(`cand@${cand.order}`)) {
        this.promotedOrders.add(cand.order);
        this.changed = true;
      }
    }
  }
  emitFacts(): TaintFacts {
    return taintStateEmitFacts.call(this);
  }

  emitOracle(): {
    awaitSettles: Map<number, TaintOcc[]>;
    guardReads: Map<number, TaintOcc[]>;
    applications: ReadonlyMap<ts.Node, ReadonlyMap<ts.Node, ApplicationVia>>;
  } {
    return taintStateEmitOracle.call(this);
  }

  private resolveArtifact(value: AbstractValue): TaintOcc[] {
    return taintStateResolveArtifact.call(this, value);
  }

  private resolveActor(value: AbstractValue): TaintOcc[] {
    return taintStateResolveActor.call(this, value);
  }

  private resolveOccs(value: AbstractValue): TaintOcc[] {
    return taintStateResolveOccs.call(this, value);
  }

  private resolvePlaceholders(
    value: AbstractValue,
    visiting: Set<string>,
    seen = new Set<AbstractValue>(),
  ): AbstractValue {
    return taintStateResolvePlaceholders.call(this, value, visiting, seen);
  }

  private resolvePlaceholder(out: AbstractValue, ph: Placeholder, visiting: Set<string>): void {
    return taintStateResolvePlaceholder.call(this, out, ph, visiting);
  }

  bindPlaceholderParams(fn: ts.Node, id: number): void {
    const params = (fn as ts.SignatureDeclaration).parameters;
    (this.fnParamSymbols.get(id) ?? []).forEach((sym, param) => {
      if (sym === undefined) return;
      const val = emptyValue();
      const rest = params[param]?.dotDotDotToken !== undefined;
      addPlaceholder(val, { fnId: id, param, ...(rest ? { rest: true } : {}) });
      this.bindSymbol(sym, val);
    });
  }
}
