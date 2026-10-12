// Modified by ZCode Feiyu.
import ts from "typescript";
import {
  clearExact,
  collapse,
  collapseInto,
  emptyValue,
  HEAP_MUTATORS,
  isDirectCallee,
  isJsonStringify,
  mergeInto,
  singleOcc,
  type AbstractValue,
} from "./domain.js";
import type { EvalContext, Evaluator } from "./taint.js";

import type { HoleSite } from "./sites.js";
import { applySuperCall } from "./classes.js";
import { handleArrayMethod } from "./array-methods.js";
import { handlePromiseReject, isPromiseReject } from "./promise-ops.js";
import { callbackSemanticsOf } from "./callbacks.js";
import { handleHeapMutator, handleObjectAssign, isObjectAssign } from "./heap-ops.js";
import { handleAsk, handleJoin, handleWorldRead } from "./relays.js";
import { applyCall, applyToFns } from "./calls-apply.js";
import { recordCall, substitute } from "./calls-record.js";
export { applyCall, applyPessimistically, applyCallbackFns } from "./calls-apply.js";
export { recordCall } from "./calls-record.js";

/**
 * Call and relay transfer rules: the facade sinks (`ask`, `files.*`), the relay
 * nodes (`Promise.all` joins and promoted iteration fan-outs), heap mutators, and
 * script-local / higher-order function calls with context-sensitive summaries. These
 * live apart from the core evaluator (taint.ts) but operate on the same `Evaluator`
 * instance.
 */

export function evalCall(ev: Evaluator, node: ts.CallExpression, ctx: EvalContext): AbstractValue {
  const actorId = ev.s.actorByCall.get(node);
  if (actorId !== undefined) return singleOcc(actorId, true);

  // `super(args)` inside a derived constructor applies the base class's constructor with
  // the actuals (param write-back + placeholder actuals), so a base ctor that stores an
  // argument in `this` sees the derived `new`'s arguments. Without this the base ctor's
  // parameters would resolve to nothing (a dropped may-flow). Returns nothing.
  if (node.expression.kind === ts.SyntaxKind.SuperKeyword) {
    applySuperCall(ev, node, ctx);
    return emptyValue();
  }

  const askId = ev.s.askByCall.get(node);
  if (askId !== undefined) return handleAsk(ev, node, askId, ctx);

  const hole = ev.s.holeByCall.get(node);
  if (hole !== undefined) return handleHole(ev, node, hole, ctx);

  const world = ev.s.worldByCall.get(node);
  if (world !== undefined) return handleWorldRead(ev, world.id, world.args, ctx);

  const join = ev.s.joinByCall.get(node);
  if (join !== undefined) return handleJoin(ev, node, join.id, join.arg, ctx);

  if (ts.isPropertyAccessExpression(node.expression)) {
    const cand = ev.s.candByCall.get(node);
    if (cand !== undefined) return handleArrayMethod(ev, node, cand, ctx);
    if (isJsonStringify(node.expression)) {
      return node.arguments[0] === undefined
        ? emptyValue()
        : collapse(ev.evalExpr(node.arguments[0], ctx));
    }
    if (isPromiseReject(node.expression)) return handlePromiseReject(ev, node, ctx);
    if (isObjectAssign(node.expression)) return handleObjectAssign(ev, node, ctx);
    if (HEAP_MUTATORS.has(node.expression.name.text)) {
      // The name-only match used to swallow DISPATCH of a script-local method that
      // merely shares a mutator name (`inbox.add(item)` on `{ add(item) { … } }`): the
      // tracked function body was never applied, so its param actuals stayed empty, facade
      // sinks inside it resolved to nothing, and markCalled/promotion were skipped — an
      // under-approximation. Route by what the member actually HOLDS: tracked callables
      // dispatch as an ordinary call (actuals + write-back + return summary). The receiver
      // smear still runs first — a merged value may be EITHER a user object or a native
      // collection (`flag ? { add(…){…} } : new Set()`), and the smear only ADDS taint
      // (sound over-approximation, never a kill). Native collections carry no tracked fns
      // in their member slot (smear-on-read drops `.fns`), so they keep the pure-smear path.
      const smear = handleHeapMutator(ev, node, node.expression, ctx);
      const memberVal = ev.evalExpr(node.expression, ctx);
      const hasTrackedFns = [...memberVal.fns].some((fn) => ev.s.fnId.has(fn));
      return hasTrackedFns ? handleGenericCall(ev, node, ctx) : smear;
    }
    // `.call` / `.apply` / `.bind` on a script-local function receiver reshape the actuals
    // before they reach the callee's positional parameters. Only intercepts when the
    // receiver actually carries a script-local function; otherwise defers to the generic
    // path (which still applies function-valued ARGUMENTS pessimistically — the keystone).
    const forwarded = handleInvocationForwarding(ev, node, node.expression, ctx);
    if (forwarded !== undefined) return forwarded;
    // A deferred continuation (`p.then(cb)`, `p.catch(cb)`, `p.finally(cb)`) runs its callback
    // after the RECEIVER settles: record the receiver's value as the settle oracle at the
    // receiver expression's position — the key the ordering walk reads before it inlines the
    // callback body. Recording only; the call's
    // own transfer (the keystone below) is untouched.
    // Keyed by the MEMBER NAME token (`then`): a chain's receivers all start at the same
    // offset (`p.then(a).finally(b)` — both receivers begin at `p`), and an await operand
    // never starts at a member name, so this key collides with nothing.
    if (callbackSemanticsOf(node, ev.checker, ev.s.program)?.deferred === true) {
      const receiver = node.expression.expression;
      ev.s.mergeSink(
        ev.s.awaitVal,
        node.expression.name.getStart(ev.s.scriptFile),
        collapse(ev.evalExpr(receiver, ctx)),
      );
    }
  }

  return handleGenericCall(ev, node, ctx);
}

/**
 * 留白（docs/analysis.md「Sites」的 Hole sites 段）。开放的留白：提示是 sink（如 ask 的
 * instructions），返回值是一个来自 run 之外的、以留白站点为标签的不透明值（类型 T）。已补全的
 * 留白：函数体在原地被 cell 调用，所以这里把它当一次**直接**应用——记成 `argument` 应用（时序
 * 走查据此在调用点内联函数体），返回值就是函数体的返回摘要（无实参，exactness 不清：调用是
 * 确定的，不是间接分派）。已补全的留白**不是**图里的节点，所以它的提示不进 sink 表。
 */
function handleHole(
  ev: Evaluator,
  node: ts.CallExpression,
  site: HoleSite,
  ctx: EvalContext,
): AbstractValue {
  ev.s.markFacade(ctx.regionStack);
  if (site.body === undefined) {
    if (site.prompt !== undefined) {
      ev.s.mergeSink(ev.s.holePrompt, site.id, collapse(ev.evalExpr(site.prompt, ctx)));
    }
    return singleOcc(site.id, true);
  }
  if (site.prompt !== undefined) ev.evalExpr(site.prompt, ctx);
  const out = emptyValue();
  for (const fn of ev.evalExpr(site.body, ctx).fns) {
    const id = ev.s.fnId.get(fn);
    if (id === undefined) continue;
    recordCall(ev, id, ctx.regionStack, [], undefined, { site: node, via: "argument" });
    mergeInto(out, substitute(ev.s.summaryOf(id), id, [], false));
  }
  return out;
}

function handleGenericCall(
  ev: Evaluator,
  node: ts.CallExpression,
  ctx: EvalContext,
): AbstractValue {
  const { explicit, places, tail } = buildActuals(ev, node.arguments, ctx);
  return applyCall(ev, node.expression, explicit, ctx, places, tail, node);
}

/**
 * Evaluate an actual-argument list into positional values, their place aliases (for
 * parameter write-back), and an optional inexact TAIL. Positional certainty ends at the
 * first `...spread`: the spread element (and every actual after it) folds into one
 * collapsed, exactness-cleared tail that binds to every parameter at index >= the spread's
 * position — the runtime unpacking length is unknown, so the smear is the sound baseline.
 * `f(...pair)` evaluated the spread as ONE actual at index 0, so params >= 1
 * resolved to nothing (a dropped may-flow: `pair[1]` never reached `f`'s second param).
 */
function buildActuals(
  ev: Evaluator,
  argsNodes: readonly ts.Expression[],
  ctx: EvalContext,
): {
  explicit: AbstractValue[];
  places: (AbstractValue | undefined)[];
  tail: AbstractValue | undefined;
} {
  const spreadIndex = argsNodes.findIndex((a) => ts.isSpreadElement(a));
  if (spreadIndex < 0) {
    const explicit = argsNodes.map((a) => ev.evalExpr(a, ctx));
    return {
      explicit,
      places: argsNodes.map((a, i) => ev.argWriteBackPlace(a, explicit[i] as AbstractValue)),
      tail: undefined,
    };
  }
  const explicit = argsNodes.slice(0, spreadIndex).map((a) => ev.evalExpr(a, ctx));
  const places = argsNodes
    .slice(0, spreadIndex)
    .map((a, i) => ev.argWriteBackPlace(a, explicit[i] as AbstractValue));
  const tail = emptyValue();
  for (const arg of argsNodes.slice(spreadIndex)) collapseInto(tail, ev.evalExpr(arg, ctx));
  return { explicit, places, tail: clearExact(tail) };
}

/**
 * `.call` / `.apply` / `.bind` on a script-local function receiver. Returns undefined when
 * the receiver carries no script-local function (so the caller defers to the generic /
 * unknown path — which still applies function-valued ARGUMENTS pessimistically, preserving
 * the keystone rule for `someUnknown.call(null, cb)`). The facade-siting layer separately
 * rejects these methods on facade callables, so only ORDINARY script functions land here.
 */
function handleInvocationForwarding(
  ev: Evaluator,
  node: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  ctx: EvalContext,
): AbstractValue | undefined {
  const method = access.name.text;
  if (method !== "call" && method !== "apply" && method !== "bind") return undefined;
  const receiverVal = ev.evalExpr(access.expression, ctx);
  const fns = [...receiverVal.fns].filter((fn) => ev.s.fnId.has(fn));
  if (fns.length === 0) return undefined;
  const exact = fns.length === 1 && isDirectCallee(access.expression);
  if (method === "call") {
    // f.call(thisArg, a, b, …) ≡ f(a, b, …): drop the thisArg, shift actuals down one.
    // Otherwise the thisArg would occupy actual index 0, and f's param 0 would resolve to `null`.
    const { explicit, places, tail } = buildActuals(ev, node.arguments.slice(1), ctx);
    return applyToFns(ev, fns, exact, explicit, ctx, places, tail, receiverVal.bound, node);
  }
  if (method === "apply") {
    // f.apply(thisArg, argsArray) ≡ f(...argsArray): the args tuple's positional shape is
    // opaque, so smear its collapsed (inexact) taint across every parameter — an ordinary
    // actual at index 1 would never be read by any positional placeholder.
    const argsArray = node.arguments[1];
    const tail =
      argsArray === undefined ? emptyValue() : clearExact(collapse(ev.evalExpr(argsArray, ctx)));
    return applyToFns(ev, fns, false, [], ctx, undefined, tail, receiverVal.bound, node);
  }
  // f.bind(thisArg, ...prefix): the result is a new function value carrying f's `fns` plus
  // a bound prefix prepended to actuals at the eventual call. Composes with the receiver's
  // existing prefix (rebinding: `f.bind(null, a).bind(null, b)` → [a, b], earlier first).
  // bind previously produced f's substituted summary (no `.fns`), so `g()` was an
  // unknown call AND the prefix never reached f's params.
  const prefixArgs = node.arguments.slice(1).map((arg) => ev.evalExpr(arg, ctx));
  const out = emptyValue();
  for (const fn of receiverVal.fns) out.fns.add(fn);
  out.bound = [...(receiverVal.bound ?? []), ...prefixArgs];
  return out;
}
