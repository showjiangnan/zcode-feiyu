// Modified by ZCode Feiyu.
import ts from "typescript";
import {
  clearExact,
  cloneValue,
  collapseInto,
  emptyValue,
  isDirectCallee,
  mergeInto,
  phKey,
  type AbstractValue,
} from "./domain.js";
import type { EvalContext, Evaluator } from "./taint.js";

import { isForeignMember } from "./callbacks.js";

import { recordCall, substitute } from "./calls-record.js";

/**
 * Apply a callee to already-evaluated argument values. Shared by ordinary call
 * expressions and tagged templates (``tag`…${e}…` `` is the call `tag(strings, e, …)`).
 * Script-local callees route through their context-sensitive summary; unknown/library
 * callees widen (see {@link handleUnknownCall}). `argPlaces[i]`, when present, is the
 * live value of a place actual, used for parameter write-back. `tail`, when present, is an
 * inexact spread smear bound to every parameter at index >= `argVals.length`. `site` is the
 * call / tagged-template node the application is recorded against (the call oracle).
 */
export function applyCall(
  ev: Evaluator,
  calleeExpr: ts.Expression,
  argVals: AbstractValue[],
  ctx: EvalContext,
  argPlaces?: (AbstractValue | undefined)[],
  tail?: AbstractValue,
  site?: ts.Node,
): AbstractValue {
  const calleeVal = ev.evalExpr(calleeExpr, ctx);
  // A library / facade member is never a script function (see {@link isForeignMember}): the
  // callables a whole-value read smeared into the member slot are the receiver's contents,
  // not the callee. `then(a, b).finally(c)` would otherwise dispatch to a and b as `.finally`.
  const foreign =
    ts.isPropertyAccessExpression(calleeExpr) &&
    isForeignMember(calleeExpr.name, ev.checker, ev.s.scriptFile);
  const fns = foreign ? [] : [...calleeVal.fns].filter((fn) => ev.s.fnId.has(fn));
  if (fns.length === 0)
    return handleUnknownCall(ev, calleeExpr, calleeVal, argVals, ctx, tail, site);
  const exact = fns.length === 1 && isDirectCallee(calleeExpr);
  return applyToFns(ev, fns, exact, argVals, ctx, argPlaces, tail, calleeVal.bound, site);
}

/**
 * Apply a resolved set of script-local functions to actuals. `explicit[i]` binds param i;
 * when `tail` is present, every parameter at index >= `explicit.length` (up to each
 * callee's arity) also binds `tail` — an `apply` / spread smear whose positional extent is
 * unknown. `exact` is the dispatch's exactness: a direct single-fn call preserves it, a
 * widened dispatch (indirect / multi-fn) clears the recorded actuals and the return summary
 * so parameter-direct asks emit inexact edges.
 *
 * When `bound` (a `bind` prefix) is present, both alignments are unioned: once WITH the
 * prefix prepended (the genuinely-bound dispatch) and once WITHOUT it. `fns` is a set, so a
 * value merged from a bound and a plain function (`flag ? f : f.bind(null, a)`) can't say
 * which entry is bound; applying both alignments is sound whichever it is, and a bound
 * dispatch is inexact (the alignment is not proven).
 */
export function applyToFns(
  ev: Evaluator,
  fns: ts.Node[],
  exact: boolean,
  explicit: AbstractValue[],
  ctx: EvalContext,
  argPlaces?: (AbstractValue | undefined)[],
  tail?: AbstractValue,
  bound?: AbstractValue[],
  site?: ts.Node,
): AbstractValue {
  const result = emptyValue();
  const hasBound = bound !== undefined && bound.length > 0;
  applyAligned(ev, fns, hasBound ? false : exact, explicit, ctx, argPlaces, tail, result, site);
  if (hasBound) {
    const prefixed = [...(bound as AbstractValue[]), ...explicit];
    const prefixedPlaces = [
      ...(bound as AbstractValue[]).map(() => undefined),
      ...(argPlaces ?? []),
    ];
    applyAligned(ev, fns, false, prefixed, ctx, prefixedPlaces, tail, result, site);
  }
  return result;
}

/** One alignment of {@link applyToFns}: bind `explicit`/`tail` to each callee and union the
 * recorded actuals + substituted return summaries into `result`. clearExact clones, so the
 * fns-binding and place write-back in recordCall stay live. */
function applyAligned(
  ev: Evaluator,
  fns: ts.Node[],
  exact: boolean,
  explicit: AbstractValue[],
  ctx: EvalContext,
  argPlaces: (AbstractValue | undefined)[] | undefined,
  tail: AbstractValue | undefined,
  result: AbstractValue,
  site?: ts.Node,
): void {
  const clear = !exact;
  for (const fn of fns) {
    const id = ev.s.fnId.get(fn);
    if (id === undefined) continue;
    const paramCount = (ev.s.fnParamSymbols.get(id) ?? []).length;
    const len = tail !== undefined ? Math.max(explicit.length, paramCount) : explicit.length;
    const args: AbstractValue[] = [];
    const places: (AbstractValue | undefined)[] = [];
    for (let i = 0; i < len; i += 1) {
      const explicitVal = i < explicit.length ? explicit[i] : undefined;
      args.push(explicitVal ?? (tail as AbstractValue));
      places.push(explicitVal !== undefined ? argPlaces?.[i] : undefined);
    }
    const recorded = clear ? args.map((a) => clearExact(a)) : args;
    recordCall(
      ev,
      id,
      ctx.regionStack,
      recorded,
      places,
      site === undefined ? undefined : { site, via: "callee" },
    );
    mergeInto(result, substitute(ev.s.summaryOf(id), id, args, clear));
  }
}

/**
 * Unknown / library call: the result is the union of the receiver's and arguments'
 * collapsed sets, exact preserved ("strings launder nothing"). AND — the keystone
 * rule — every script-local function among the arguments is pessimistically applied:
 * the library may invoke it with anything derived from the receiver or a sibling
 * argument, so each of its parameters receives that receiver ∪ siblings union with
 * exactness cleared, and its return summary joins the result (cleared). This closes
 * the higher-order laundering holes: `.then`/`.catch` callbacks (both directions),
 * `.replace(p, fn)`, `Array.from(xs, fn)`, a named callback to `.map`, an inline
 * callback to a non-whitelisted method (`.findIndex`). The old branch
 * collapsed the arguments (which drops `.fns`) and never visited the callback body,
 * so any taint the callback captured or returned was silently dropped.
 *
 * Separately captures PLACEHOLDER-parameter invocations for the promise machinery
 * ({@link handleNewUnknown} / {@link evalAwait}): a placeholder callee (`resolve(draft)` —
 * resolve is a param) records its args, and a placeholder-valued argument (`draft.then(onOk)`)
 * records the pot the unknown fn may invoke it with. Neither affects THIS call's result;
 * they seed `phCallActuals`, read only when the enclosing callback is applied as a promise
 * executor or a thenable's `then`.
 */
function handleUnknownCall(
  ev: Evaluator,
  calleeExpr: ts.Expression,
  calleeVal: AbstractValue,
  argVals: AbstractValue[],
  ctx: EvalContext,
  tail?: AbstractValue,
  site?: ts.Node,
): AbstractValue {
  const applied = emptyValue();
  if (ts.isPropertyAccessExpression(calleeExpr))
    collapseInto(applied, ev.evalExpr(calleeExpr.expression, ctx));
  for (const arg of argVals) collapseInto(applied, arg);
  if (tail !== undefined) collapseInto(applied, tail);

  const out = cloneValue(applied);

  // Pessimistic application of function-valued arguments (exactness cleared). The pot a
  // callback's parameters receive is the sibling DATA, not the callables themselves: a
  // function argument is the callback being invoked, not a value the library hands to a
  // sibling callback (mirrors {@link handleNewUnknown}). With the callables left in,
  // `draft.then(cb)` makes cb's parameter "maybe cb", so any unknown call on that parameter
  // inside the body (`Promise.resolve(text)`) re-applies cb to itself — a phantom recursion
  // the call oracle then inlines as a `loop` (reentrant-then-composition).
  const actual = clearExact(applied);
  actual.fns.clear();
  for (const arg of argVals) applyPessimistically(ev, arg, actual, ctx, out, site);
  if (tail !== undefined) applyPessimistically(ev, tail, actual, ctx, out, site);

  // Capture (b): a placeholder-valued argument may be invoked by the unknown fn with the
  // pot (`draft.then(onOk)` → onOk's invocations may see the receiver draft).
  for (const arg of argVals) recordPhCallActuals(ev, arg, actual);
  if (tail !== undefined) recordPhCallActuals(ev, tail, actual);
  // Capture (a): a direct call of a placeholder callee (`resolve(draft)`) passes its args
  // to that param's invocation.
  if (calleeVal.phs.size > 0) {
    const argPot = emptyValue();
    for (const arg of argVals) collapseInto(argPot, arg);
    if (tail !== undefined) collapseInto(argPot, tail);
    recordPhCallActuals(ev, calleeVal, argPot);
  }
  return out;
}

/**
 * Keystone application of every script-local function reachable in `source`: each of its
 * parameters receives `pot` (already exactness-cleared), and its substituted return summary
 * joins `out`. Shared by {@link handleUnknownCall} and {@link handleNewUnknown} (`new`).
 */
export function applyPessimistically(
  ev: Evaluator,
  source: AbstractValue,
  pot: AbstractValue,
  ctx: EvalContext,
  out: AbstractValue,
  site?: ts.Node,
): void {
  for (const fn of source.fns) {
    const id = ev.s.fnId.get(fn);
    if (id === undefined) continue;
    const actuals = (ev.s.fnParamSymbols.get(id) ?? []).map(() => pot);
    recordCall(
      ev,
      id,
      ctx.regionStack,
      actuals,
      undefined,
      site === undefined ? undefined : { site, via: "argument" },
    );
    mergeInto(out, substitute(ev.s.summaryOf(id), id, actuals, true));
  }
}

/**
 * Apply script-local functions handed to a per-element library call (`xs.map(review)`) with
 * positional actuals already shaped by the registry (element / whole / accumulator slots).
 * Records each as an `argument` application at `site` inside the candidate's region stack and
 * returns the union of the substituted return summaries (inexact: the dispatch is indirect).
 */
export function applyCallbackFns(
  ev: Evaluator,
  fns: readonly ts.Node[],
  actuals: AbstractValue[],
  regionStack: string[],
  site: ts.Node,
): AbstractValue {
  const out = emptyValue();
  for (const fn of fns) {
    const id = ev.s.fnId.get(fn);
    if (id === undefined) continue;
    recordCall(ev, id, regionStack, actuals, undefined, { site, via: "argument" });
    mergeInto(out, substitute(ev.s.summaryOf(id), id, actuals, true));
  }
  return out;
}

/** Record `value` against every placeholder-parameter carried by `source` (see phCallActuals). */
function recordPhCallActuals(ev: Evaluator, source: AbstractValue, value: AbstractValue): void {
  for (const ph of source.phs.values()) ev.s.recordPhCall(phKey(ph), value);
}
