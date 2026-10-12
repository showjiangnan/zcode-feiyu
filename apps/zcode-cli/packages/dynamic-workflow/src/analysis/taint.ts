// Modified by ZCode Feiyu.
import ts from "typescript";
import type { WorkflowProgram } from "../compiler/compile.js";
import type { SiteTable } from "./sites.js";
import { addPlaceholder, collapse, emptyValue, mergeInto, type AbstractValue } from "./domain.js";

import { evalClasses } from "./classes.js";

import { bindPattern, extractField, selectField } from "./patterns.js";
import { TaintState } from "./state.js";
import { evaluatorVisit, evaluatorHandleDeclaration } from "./taint-visit.js";
import {
  evaluatorResolvePlace,
  evaluatorPlaceField,
  evaluatorArgWriteBackPlace,
} from "./taint-places.js";
import {
  evaluatorEvalExpr,
  evaluatorEvalIdentifier,
  evaluatorArgumentsValue,
  evaluatorEvalBinary,
  evaluatorEvalPropertyAccess,
  evaluatorEvalElementAccess,
  evaluatorReceiverSymbol,
} from "./taint-expressions.js";

/**
 * The taint pass: a gen-only, may-flow dataflow analysis over the typed AST that
 * turns the site table into edge-bearing facts. It is the data half of the fused
 * interpreter (interpret.ts): the fixpoint here runs taint-only, and after
 * convergence the temporal walk (causality-order.ts) reads this pass's state as its
 * oracle. See domain.ts for the
 * abstract-value algebra, state.ts for the fixpoint storage, and calls.ts for the
 * call/relay transfer rules.
 *
 * ## Why flow-INsensitivity is sound here
 *
 * The analysis is gen-only: taint is a union over a finite powerset lattice, there
 * are no sanitizers and no strong updates (no kills). With no kills, the order in
 * which statements execute cannot remove a fact, so a single global environment with
 * weak (join-only) updates over-approximates every execution order at once. That is
 * exactly what a may-flow graph wants ("A may feed B"), and it makes loop-carried
 * variables (the planner/reviewer `feedback`) fall out for free: the reassignment
 * inside the loop just unions into the same binding the loop head reads. We iterate
 * the whole-script transfer to a fixpoint; monotonicity + the finite lattice
 * guarantee termination (a defensive cap throws if it ever fails to converge — a
 * thrown cap is a bug, never a silent truncation).
 */

const ITERATION_CAP = 100;

export interface EvalContext {
  /** Enclosing dataflow regions, innermost last: "top", `fn@<id>`, `cand@<order>`. */
  regionStack: string[];
  /** Sink for `return` statements in this region. */
  onReturn: (value: AbstractValue) => void;
}

/**
 * The taint half of the fused interpreter:
 * drive the whole-script transfer to a fixpoint. Emission is the caller's business —
 * interpret.ts reads the converged state through `emitFacts` / `emitOracle` and runs
 * the temporal walk over the same state.
 */
export class Evaluator {
  readonly s: TaintState;
  readonly checker: ts.TypeChecker;

  constructor(workflow: WorkflowProgram, table: SiteTable) {
    this.s = new TaintState(workflow, table);
    this.checker = this.s.checker;
  }

  converge(): void {
    let iterations = 0;
    do {
      this.s.changed = false;
      iterations += 1;
      if (iterations > ITERATION_CAP) {
        throw new Error(`taint analysis failed to converge after ${ITERATION_CAP} iterations`);
      }
      this.iterate();
      this.s.propagateReachability();
      this.s.recomputePromotion();
    } while (this.s.changed);
  }

  private iterate(): void {
    // Pre-bind function-declaration names to their function value (hoisting).
    for (const fn of this.s.functions) {
      if (ts.isFunctionDeclaration(fn) && fn.name !== undefined) {
        const sym = this.checker.getSymbolAtLocation(fn.name);
        if (sym !== undefined) {
          const val = emptyValue();
          val.fns.add(fn);
          this.s.bindSymbol(sym, val);
        }
      }
    }

    const topCtx: EvalContext = {
      onReturn: (value) => this.s.mergeReturn(collapse(value)),
      regionStack: ["top"],
    };
    for (const stmt of this.s.body.statements) this.visit(stmt, topCtx);

    // Class bodies run after top-level statements (field initializers may read top-level
    // bindings) and before the function pass (methods must be registered as instance
    // fields before dispatch): field/static initializers, static blocks, method/accessor
    // field registration, and the `extends` merge. The fixpoint reconciles any ordering.
    evalClasses(this);

    for (const fn of this.s.functions) this.evalFunction(fn);
  }

  private evalFunction(fn: ts.Node): void {
    const id = this.s.fnId.get(fn);
    if (id === undefined) return;
    this.s.bindPlaceholderParams(fn, id);

    const ctx: EvalContext = {
      onReturn: (value) => {
        if (mergeInto(this.s.summaryOf(id), value)) this.s.changed = true;
      },
      regionStack: [`fn@${id}`],
    };
    // Binding-pattern parameters (`function f([x, y]) {}`, a `.then(([x, y]) => …)` callback)
    // carry no symbol in fnParamSymbols, so bindPlaceholderParams cannot bind them. Bind the
    // whole pattern to this param's placeholder through the shared pattern machinery, so the
    // extracted names resolve to the recorded actuals (incl. the keystone rule's pessimistic
    // application). Before this loop existed, these params stayed undefined, so the
    // body's reads of the destructured names saw nothing — a dropped may-flow.
    (fn as ts.SignatureDeclaration).parameters.forEach((param, index) => {
      if (ts.isIdentifier(param.name)) return;
      const val = emptyValue();
      const rest = param.dotDotDotToken !== undefined;
      addPlaceholder(val, { fnId: id, param: index, ...(rest ? { rest: true } : {}) });
      this.bindPattern(param.name, val, ctx);
    });
    // Default parameter initializers join into the parameter alongside call actuals.
    // Previously they were never evaluated, so `build(prefix = s)` called with no
    // argument dropped `s`'s taint entirely (the placeholder resolved to nothing).
    for (const param of (fn as ts.SignatureDeclaration).parameters) {
      if (param.initializer === undefined) continue;
      this.bindPattern(param.name, this.evalExpr(param.initializer, ctx), ctx);
    }
    const bodyNode = (fn as ts.SignatureDeclaration & { body?: ts.Node }).body;
    if (bodyNode === undefined) return;
    if (ts.isBlock(bodyNode)) {
      for (const stmt of bodyNode.statements) this.visit(stmt, ctx);
    } else {
      // Concise arrow body: the body expression is the return value.
      ctx.onReturn(this.evalExpr(bodyNode as ts.Expression, ctx));
    }
  }

  /**
   * Record a guard expression's value as the control-dependence oracle, keyed by the
   * guard node's START OFFSET — the same node `traceOrder` hands to `controllersOf`, so a
   * parenthesized guard is keyed by its ParenthesizedExpression. This is a SINK, not a
   * flow: the value is recorded and not joined into anything, because a condition does not
   * join the data contract (see the ConditionalExpression case in evalExpr). Consumed only
   * by the causality graph.
   */
  recordGuard(node: ts.Expression, value: AbstractValue): void {
    this.s.mergeSink(this.s.guardVal, node.getStart(this.s.scriptFile), value);
  }
  visit(node: ts.Node, ctx: EvalContext): void {
    return evaluatorVisit.call(this, node, ctx);
  }

  handleDeclaration(decl: ts.VariableDeclaration, ctx: EvalContext): void {
    return evaluatorHandleDeclaration.call(this, decl, ctx);
  }

  resolvePlace(expr: ts.Expression, create = false): AbstractValue | undefined {
    return evaluatorResolvePlace.call(this, expr, create);
  }

  private placeField(
    container: AbstractValue,
    key: string,
    create: boolean,
  ): AbstractValue | undefined {
    return evaluatorPlaceField.call(this, container, key, create);
  }

  argWriteBackPlace(arg: ts.Expression, value: AbstractValue): AbstractValue | undefined {
    return evaluatorArgWriteBackPlace.call(this, arg, value);
  }

  /**
   * Bind a destructuring pattern (or a single name). See {@link bindPattern} in patterns.ts;
   * exposed as a thin method because the aliasing-bind machinery is used across modules.
   */
  bindPattern(
    name: ts.BindingName,
    value: AbstractValue,
    ctx: EvalContext,
    sourcePlace?: AbstractValue,
  ): void {
    bindPattern(this, name, value, ctx, sourcePlace);
  }

  /** The live field at `key` of a place, for destructuring aliasing (see patterns.ts). */
  extractField(container: AbstractValue, key: string): AbstractValue {
    return extractField(this, container, key);
  }

  /** Read a statically-known field with smear-on-read, else collapse (see patterns.ts). */
  selectField(value: AbstractValue, key: string): AbstractValue {
    return selectField(value, key);
  }
  evalExpr(node: ts.Expression, ctx: EvalContext): AbstractValue {
    return evaluatorEvalExpr.call(this, node, ctx);
  }

  private evalIdentifier(node: ts.Identifier): AbstractValue {
    return evaluatorEvalIdentifier.call(this, node);
  }

  private argumentsValue(node: ts.Identifier): AbstractValue | undefined {
    return evaluatorArgumentsValue.call(this, node);
  }

  private evalBinary(node: ts.BinaryExpression, ctx: EvalContext): AbstractValue {
    return evaluatorEvalBinary.call(this, node, ctx);
  }

  private evalPropertyAccess(node: ts.PropertyAccessExpression, ctx: EvalContext): AbstractValue {
    return evaluatorEvalPropertyAccess.call(this, node, ctx);
  }

  private evalElementAccess(node: ts.ElementAccessExpression, ctx: EvalContext): AbstractValue {
    return evaluatorEvalElementAccess.call(this, node, ctx);
  }

  receiverSymbol(expr: ts.Expression): ts.Symbol | undefined {
    return evaluatorReceiverSymbol.call(this, expr);
  }
}
