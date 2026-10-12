// Modified by ZCode Feiyu.
import ts from "typescript";

import { liveField, mergeInto, peelPlace, staticIndexKey, type AbstractValue } from "./domain.js";

import { classNodeOfSymbol, enclosingBaseInstance, enclosingClassInstance } from "./classes.js";

import type { Evaluator } from "./taint.js";

/**
 * The LIVE (shared, unclonable) abstract value a *place expression* denotes, or
 * undefined for non-places (calls, literals, computed access, operators). A place is
 * an identifier (its env slot) or a chain of static property / literal-index element
 * accesses rooted at a place. Value-preserving wrappers (parens / `as` / `satisfies` /
 * non-null / type assertion) are peeled at every level. This is the single primitive
 * behind aliasing: bindings, container-literal fields, write receivers and param
 * write-back all resolve places through it. Reads must NOT call this (they clone).
 *
 * `create` governs missing field slots. WRITE receivers create empty fields on demand
 * (`arr[0].f = t` materializes `arr[0]`). Read-side callers (aliasing binds,
 * container-literal embedding, write-back actuals) pass `create=false`: an absent field
 * returns undefined so the caller falls back to value semantics (readField's collapse),
 * which correctly surfaces the container's own occurrences. Fabricating an empty field
 * there would alias to a phantom and DROP the opaque container's taint (e.g. reading
 * `review.feedback` off an opaque ask result must yield collapse(review), not ∅).
 */

export function evaluatorResolvePlace(
  this: Evaluator,
  expr: ts.Expression,
  create = false,
): AbstractValue | undefined {
  const e = peelPlace(expr);
  if (ts.isAwaitExpression(e)) {
    // `await p` settles to the promise's ONE resolved object, so it IS the operand's
    // place — awaiting the same promise twice yields the same object, and a mutation
    // between the awaits is visible through the second (`async-promise-double-await-mutate`).
    // A custom THENABLE is the exception: its `then` transforms the value, so the result
    // is NOT the operand; detect that by a tracked `then` field and fall back to value
    // semantics (evalAwait models the continuation flow there).
    const inner = this.resolvePlace(e.expression, create);
    if (inner === undefined) return undefined;
    const thenField = inner.fields.get("then");
    return thenField !== undefined && thenField.fns.size > 0 ? undefined : inner;
  }
  if (e.kind === ts.SyntaxKind.ThisKeyword) {
    // `this` is the LIVE shared instance, so `this.x = v` mutates the value every alias
    // (and every other instance of the class) sees.
    return enclosingClassInstance(this, e);
  }
  if (e.kind === ts.SyntaxKind.SuperKeyword) {
    // `super.x = v` writes the BASE class's shared instance (which the derived instance
    // weak-merges in), so the write is visible through the derived `this` too.
    return enclosingBaseInstance(this, e);
  }
  if (ts.isIdentifier(e)) {
    const sym = this.checker.getSymbolAtLocation(e);
    if (sym === undefined) return undefined;
    // A class-name place (`C.staticField = v`) is the shared instance — static writes
    // conflate with instance state.
    const cls = classNodeOfSymbol(this, sym);
    if (cls !== undefined) return this.s.instanceOf(cls);
    return this.s.envSlot(sym);
  }
  if (ts.isPropertyAccessExpression(e)) {
    const base = this.resolvePlace(e.expression, create);
    return base === undefined ? undefined : this["placeField"](base, e.name.text, create);
  }
  if (ts.isElementAccessExpression(e)) {
    const key = staticIndexKey(e.argumentExpression);
    if (key === undefined) return undefined;
    const base = this.resolvePlace(e.expression, create);
    return base === undefined ? undefined : this["placeField"](base, key, create);
  }
  if (ts.isConditionalExpression(e)) {
    // `flag ? box1 : box2` may BE either arm at runtime, so a write through the binding
    // must weakly reach BOTH (never strong-update one). Return a value carrying mayAlias =
    // {each arm's place}; writeField/handleHeapMutator replay the write into every target
    // inexactly. The value also snapshots the arms' current taint (a read of the binding
    // unions the arms, matching the prior evalExpr union).
    // The ternary was not a place, so the alias write
    // reached neither box. Requires ALL arms to be places — if any arm is a non-place value
    // (e.g. `flag ? plain : f.bind(null, pre)`, whose bound prefix only evalExpr computes),
    // fall back to value semantics so that arm's value is not lost. Nothing is persisted on
    // that failure path: an expression that is not a place owns no heap node.
    const whenTrue = this.resolvePlace(e.whenTrue, create);
    const whenFalse = this.resolvePlace(e.whenFalse, create);
    if (whenTrue === undefined || whenFalse === undefined) return undefined;
    // The wrapper is the PERSISTENT node of this ConditionalExpression (state.ts
    // condPlaceOf), never a fresh value per pass — the canonical-heap invariant
    // (see joinResultOf). Without it, a syntactically NESTED ternary place
    // (`f2 ? (f ? box1 : box2) : box3`) would put the inner pass-fresh wrapper into
    // the outer's mayAlias set, which dedups by IDENTITY, so `changed` would never
    // settle and the fixpoint would hit ITERATION_CAP. (A ternary chained through
    // `const` bindings converged only because env-slot adoption happened to make its
    // wrapper persistent.)
    const out = this.s.condPlaceOf(e);
    const targets = (out.mayAlias ??= new Set());
    for (const arm of [whenTrue, whenFalse]) {
      if (!targets.has(arm)) {
        targets.add(arm);
        this.s.changed = true;
      }
      // The wrapper also snapshots the arms' current taint, so a READ of the binding
      // unions the arms (matching the prior evalExpr union).
      if (mergeInto(out, arm)) this.s.changed = true;
    }
    return out;
  }
  if (ts.isCallExpression(e)) {
    // A `Promise.all` join result is a live place: its element fields carry may-alias
    // back-references to the (place) inputs (see handleJoin), so destructuring / indexing
    // the awaited result aliases the originals. Any other call is not a place.
    //
    // Gated on `joinResults` — the registry handleJoin populates — NOT on the site table:
    // several read-side callers are `resolvePlace(x) ?? evalExpr(x)` (literals.ts
    // fieldValue, heap-ops.ts Object.assign source, array-methods.ts reduce seed), and
    // their contract is that a place resolves only once it has been EVALUATED. Resolving a
    // join eagerly off `joinByCall` short-circuits those callers, so handleJoin never runs
    // for a join in one of those positions and the site, its edges, markFacade and fan-out
    // promotion all vanish. Undefined-until-first-evaluated is therefore load-bearing; the
    // node handed out is still the one canonical object, which is all the fixpoint needs.
    return this.s.joinResults.get(e);
  }
  return undefined;
}

export function evaluatorPlaceField(
  this: Evaluator,
  container: AbstractValue,
  key: string,
  create: boolean,
): AbstractValue | undefined {
  const field = container.fields.get(key);
  if (field !== undefined) return field;
  return create ? liveField(container, key) : undefined;
}

/**
 * The parameter write-back target for an actual argument `arg` whose evaluated value is
 * `value`. A place actual resolves to its live slot (write-back aliases through it, as
 * before). An object/array LITERAL's evaluated value IS its allocation-site place
 * (state.literalPlaceOf), and its FIELDS hold live places (`poke({ box })` — the literal's
 * `box` field IS the box slot), so that value is the write-back target: `mergeHeapEffects`
 * descends into it and a field the callee wrote through `p.box` lands on the shared `box`
 * slot, while a field written on the literal itself (`tag({ name }, t)` → `box.note = t`)
 * persists on the place and reaches whoever the callee hands the object to.
 * A literal argument once skipped write-back entirely, so mutations through its live
 * sub-objects were invisible to the caller; and when the literal was a per-pass fresh
 * value, that write-back re-reported a change on every pass and the fixpoint never
 * settled.
 */

export function evaluatorArgWriteBackPlace(
  this: Evaluator,
  arg: ts.Expression,
  value: AbstractValue,
): AbstractValue | undefined {
  const place = this.resolvePlace(arg);
  if (place !== undefined) return place;
  const peeled = peelPlace(arg);
  return ts.isObjectLiteralExpression(peeled) || ts.isArrayLiteralExpression(peeled)
    ? value
    : undefined;
}
