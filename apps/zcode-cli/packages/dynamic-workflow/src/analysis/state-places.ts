// Modified by ZCode Feiyu.
import ts from "typescript";

import { emptyValue, mergeInto, type AbstractValue } from "./domain.js";

import type { TaintState } from "./state.js";

export function taintStateEnvSlot(this: TaintState, sym: ts.Symbol): AbstractValue {
  let slot = this.env.get(sym);
  if (slot === undefined) {
    slot = emptyValue();
    this.env.set(sym, slot);
  }
  return slot;
}

export function taintStateSummaryOf(this: TaintState, id: number): AbstractValue {
  let slot = this.summaries.get(id);
  if (slot === undefined) {
    slot = emptyValue();
    this.summaries.set(id, slot);
  }
  return slot;
}

/** The shared abstract instance of a class node, created empty on demand (persistent). */

export function taintStateInstanceOf(this: TaintState, cls: ts.Node): AbstractValue {
  let inst = this.classInstances.get(cls);
  if (inst === undefined) {
    inst = emptyValue();
    this.classInstances.set(cls, inst);
  }
  return inst;
}

/**
 * The shared abstract result of a join call, created empty on demand (persistent).
 *
 * THE CANONICAL-HEAP INVARIANT: every value that models runtime storage — anything that
 * can be aliased, written through, or referenced from a `mayAlias` set — is keyed by a
 * static program point and lives across fixpoint passes; per-pass temporaries are
 * snapshots only. handleJoin used to mint a FRESH result value each pass, so
 * `Promise.all([Promise.all([…])])` added a never-before-seen object to the outer
 * element's `mayAlias` set every pass. That set dedups by IDENTITY (domain.ts), so
 * `changed` stayed true forever and the fixpoint hit ITERATION_CAP. Keying the result by
 * the call node makes the identity stable, so the union saturates.
 */

export function taintStateJoinResultOf(this: TaintState, call: ts.CallExpression): AbstractValue {
  let result = this.joinResults.get(call);
  if (result === undefined) {
    result = emptyValue();
    this.joinResults.set(call, result);
  }
  return result;
}

/**
 * The shared abstract place of a conditional expression, created empty on demand
 * (persistent). Same canonical-heap invariant as {@link joinResultOf}: a per-pass
 * wrapper for `flag ? box1 : box2` diverged the fixpoint as soon as it became a
 * `mayAlias` target — which a SYNTACTICALLY NESTED ternary place
 * (`f2 ? (f ? box1 : box2) : box3`) does on every pass.
 */

export function taintStateCondPlaceOf(
  this: TaintState,
  node: ts.ConditionalExpression,
): AbstractValue {
  let place = this.condPlaces.get(node);
  if (place === undefined) {
    place = emptyValue();
    this.condPlaces.set(node, place);
  }
  return place;
}

/**
 * The allocation-site place of a container literal (`{…}` / `[…]`): the value its first
 * evaluation produced, kept across passes and weak-merged with every re-evaluation
 * (persistent). Same canonical-heap invariant as {@link joinResultOf}: a literal IS runtime
 * storage — a callee writes through it (`fill([], v)`, `tag({ name }, t)` with
 * `box.note = t`), a binding adopts it, a spread shares its fields — so a value recreated
 * every pass can never settle once something persistent merges INTO it. The
 * parameter write-back targeted the per-pass fresh literal, reported a change on every pass
 * (the note it had just added was gone again), and the fixpoint hit ITERATION_CAP with no
 * state growing at all. Any `f({ … })` whose callee mutates its parameter was affected.
 *
 * Adopting the first evaluation (rather than minting an empty slot) keeps the literal's
 * aliasing: a field that stores a live place (`{ box }`, `[obj]`) keeps pointing at that
 * slot, and later passes merge the same slot into itself — an identity no-op. Snapshot
 * fields accumulate monotonically, exactly as an env slot bound to the literal always did.
 */

export function taintStateLiteralPlaceOf(
  this: TaintState,
  node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  fresh: AbstractValue,
): AbstractValue {
  const place = this.literalPlaces.get(node);
  if (place === undefined) {
    this.literalPlaces.set(node, fresh);
    return fresh;
  }
  if (mergeInto(place, fresh)) this.changed = true;
  return place;
}
