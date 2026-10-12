// Modified by ZCode Feiyu.
import ts from "typescript";

import {
  addPlaceholder,
  clearExact,
  cloneValue,
  collapse,
  collapseInto,
  COMPOUND_ASSIGNMENT_OPS,
  emptyValue,
  isNonArrowFunctionLike,
  readField,
  staticIndexKey,
  unionValues,
  type AbstractValue,
} from "./domain.js";
import { applyCall, evalCall } from "./calls.js";
import {
  applyConstructor,
  applyMixinConstructor,
  evalAwait,
  handleNewUnknown,
} from "./promise-ops.js";
import {
  classConstructor,
  classNodeOfSymbol,
  enclosingBaseInstance,
  enclosingClassInstance,
  hasUnresolvedHeritage,
  resolveClassNode,
} from "./classes.js";
import { handleAssignment, handleCompoundAssignment } from "./assign.js";

import { evalArrayLiteral, evalObjectLiteral } from "./literals.js";

import type { EvalContext, Evaluator } from "./taint.js";

// -- expression evaluator ------------------------------------------------

export function evaluatorEvalExpr(
  this: Evaluator,
  node: ts.Expression,
  ctx: EvalContext,
): AbstractValue {
  switch (node.kind) {
    case ts.SyntaxKind.Identifier:
      return this["evalIdentifier"](node as ts.Identifier);
    case ts.SyntaxKind.ParenthesizedExpression:
      return this.evalExpr((node as ts.ParenthesizedExpression).expression, ctx);
    case ts.SyntaxKind.AwaitExpression:
      return evalAwait(this, node as ts.AwaitExpression, ctx);
    case ts.SyntaxKind.AsExpression:
    case ts.SyntaxKind.SatisfiesExpression:
      return this.evalExpr((node as ts.AsExpression).expression, ctx);
    case ts.SyntaxKind.NonNullExpression:
      return this.evalExpr((node as ts.NonNullExpression).expression, ctx);
    case ts.SyntaxKind.TypeAssertionExpression:
      return this.evalExpr((node as ts.TypeAssertion).expression, ctx);
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ArrowFunction: {
      const out = emptyValue();
      out.fns.add(node);
      return out;
    }
    case ts.SyntaxKind.ThisKeyword: {
      // `this` resolves to the enclosing class's shared instance (a live reference, read
      // here as a clone like an identifier). Outside any class it is empty. Writes
      // (`this.x = v`) go through resolvePlace's ThisKeyword case, which returns the
      // live instance so the mutation lands on the shared value.
      const instance = enclosingClassInstance(this, node);
      return instance === undefined ? emptyValue() : cloneValue(instance);
    }
    case ts.SyntaxKind.SuperKeyword: {
      // `super` resolves to the BASE class's shared instance, so `super.reveal()` dispatches
      // to the base method summary and `super.x` reads the base field. (`super(args)` is a
      // CallExpression intercepted in evalCall before this.) Empty outside a derived class.
      // SuperKeyword previously had no case → emptyValue → `super.m` had no fns → unknown call.
      const base = enclosingBaseInstance(this, node);
      return base === undefined ? emptyValue() : cloneValue(base);
    }
    default:
      break;
  }
  if (ts.isCallExpression(node)) return evalCall(this, node, ctx);
  if (ts.isPropertyAccessExpression(node)) return this["evalPropertyAccess"](node, ctx);
  if (ts.isElementAccessExpression(node)) return this["evalElementAccess"](node, ctx);
  if (ts.isBinaryExpression(node)) return this["evalBinary"](node, ctx);
  if (ts.isTemplateExpression(node)) {
    const out = emptyValue();
    for (const span of node.templateSpans) collapseInto(out, this.evalExpr(span.expression, ctx));
    return out;
  }
  if (ts.isTaggedTemplateExpression(node)) {
    // A tagged template calls tag(strings, ...values). Without this case,
    // evalExpr would fall through to emptyValue() and lose all interpolated
    // taint, for both String.raw and user-defined tags.
    const argVals: AbstractValue[] = [emptyValue()]; // the frozen strings array (untainted)
    if (ts.isTemplateExpression(node.template)) {
      for (const span of node.template.templateSpans)
        argVals.push(this.evalExpr(span.expression, ctx));
    }
    return applyCall(this, node.tag, argVals, ctx, undefined, undefined, node);
  }
  if (ts.isYieldExpression(node)) {
    // `yield e` / `yield* e` joins the operand into the enclosing function's return
    // summary; the yield expression's own value is empty. Previously `yield` had no
    // case, so a generator's yielded (tainted) values never entered its summary.
    if (node.expression !== undefined) ctx.onReturn(this.evalExpr(node.expression, ctx));
    return emptyValue();
  }
  if (ts.isConditionalExpression(node)) {
    // Evaluate the condition for effect (asks/reads inside it must be visited so their
    // in/out edges are emitted); its taint is NOT unioned into the result — control
    // dependence is not part of the may-flow data contract, mirroring how `if`/`while`
    // conditions are handled. Previously the condition was never visited, so a facade
    // sink sitting in it (`(await ask()) ? … : …`) vanished from the graph entirely.
    // Phase 2 RECORDS it as a guard sink, which does not contradict the above: a sink
    // says what the branch reads, it still joins nothing into the value.
    this.recordGuard(node.condition, this.evalExpr(node.condition, ctx));
    return unionValues(this.evalExpr(node.whenTrue, ctx), this.evalExpr(node.whenFalse, ctx));
  }
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    return collapse(this.evalExpr(node.operand, ctx));
  }
  // `typeof`/`void`/`delete` are DISTINCT node kinds (not PrefixUnaryExpression), so the
  // operand needs its own evaluation or a facade call inside it loses all edges. All three evaluate the operand for effects; `typeof` yields a string derived
  // from it (collapse — "strings launder nothing"), `void`/`delete` yield undefined /
  // boolean (empty), and `delete` performs NO kill (gen-only).
  if (ts.isTypeOfExpression(node)) return collapse(this.evalExpr(node.expression, ctx));
  if (ts.isVoidExpression(node) || ts.isDeleteExpression(node)) {
    this.evalExpr(node.expression, ctx);
    return emptyValue();
  }
  // A container literal evaluates to its allocation-site PLACE (state.literalPlaceOf): the
  // fresh per-pass evaluation is merged into the persistent place and the place is what
  // flows on — so a write through it (parameter write-back, a later field assignment through
  // an alias) lands on storage that survives the pass.
  if (ts.isArrayLiteralExpression(node))
    return this.s.literalPlaceOf(node, evalArrayLiteral(this, node, ctx));
  if (ts.isObjectLiteralExpression(node))
    return this.s.literalPlaceOf(node, evalObjectLiteral(this, node, ctx));
  if (ts.isNewExpression(node)) {
    // `new C(args)` on a script-local class applies the constructor (placeholder actuals
    // + param write-back) and returns a REFERENCE to the class's shared abstract
    // instance, so `const h = new C(s)` aliases h to that instance (all instances of a
    // class are conflated — weak).
    const cls = resolveClassNode(this, node.expression);
    if (cls !== undefined) {
      const ctor = classConstructor(this, cls);
      const ctorId = ctor === undefined ? undefined : this.s.fnId.get(ctor);
      const args = node.arguments ?? [];
      const argVals = args.map((arg) => this.evalExpr(arg, ctx));
      if (ctorId !== undefined) {
        const argPlaces = args.map((arg, i) =>
          this.argWriteBackPlace(arg, argVals[i] as AbstractValue),
        );
        applyConstructor(this, ctorId, ctx, argVals, argPlaces, node);
      } else if (hasUnresolvedHeritage(this, cls)) {
        // No resolvable constructor because the base is a mixin CALL (`class D extends
        // mix(Base)`): the inherited ctor may store any argument in any field, so smear the
        // args (inexact) into the instance. Sound over-approximation (see applyMixinConstructor).
        applyMixinConstructor(this, ctx, this.s.instanceOf(cls), argVals);
      }
      return this.s.instanceOf(cls);
    }
    // Non-class callee (`new Set([x])`, `new Promise(exec)`): the unknown-`new` keystone —
    // union of the argument collapses PLUS pessimistic application of function-valued args
    // AND the promise-executor rule (what a function arg feeds to its own params joins the
    // result). The old branch only collapsed arguments, so `new Promise((resolve) =>
    // resolve(draft))` never let draft reach the promise's value (no keystone for `new`).
    return handleNewUnknown(this, node, ctx);
  }
  if (ts.isSpreadElement(node)) return collapse(this.evalExpr(node.expression, ctx));
  return emptyValue();
}

export function evaluatorEvalIdentifier(this: Evaluator, node: ts.Identifier): AbstractValue {
  const sym = this.checker.getSymbolAtLocation(node);
  if (sym === undefined) return this["argumentsValue"](node) ?? emptyValue();
  // A class-name reference reads the class's shared instance (static access conflates
  // with instance access — `C.staticProp` and `this.prop` hit the one instance value).
  const cls = classNodeOfSymbol(this, sym);
  if (cls !== undefined) return cloneValue(this.s.instanceOf(cls));
  const slot = this.s.env.get(sym);
  if (slot !== undefined) return cloneValue(slot);
  // Unbound identifier: the implicit `arguments` object of the enclosing (non-arrow)
  // function resolves to a rest-like placeholder over ALL its actuals; everything else
  // is empty.
  return this["argumentsValue"](node) ?? emptyValue();
}

/**
 * The implicit `arguments` object as a rest-like placeholder gathering every actual of
 * the nearest enclosing NON-arrow function (param index 0, rest). `arguments[i]` then
 * reads a field of it → collapse keeps the placeholder → emission expands it to all
 * recorded actuals (a sound over-approximation: `arguments[0]` yields the whole list).
 * Arrow functions have no own `arguments`, so the ancestor walk skips them and binds the
 * enclosing function's — matching JS's lexical `arguments`. Previously `arguments`
 * resolved to the lib symbol with no env slot, so `arguments[0]` dropped every
 * actual's taint.
 */

export function evaluatorArgumentsValue(
  this: Evaluator,
  node: ts.Identifier,
): AbstractValue | undefined {
  if (node.text !== "arguments") return undefined;
  const fn = ts.findAncestor(node, (a) => isNonArrowFunctionLike(a));
  const id = fn === undefined ? undefined : this.s.fnId.get(fn);
  if (id === undefined) return undefined;
  const val = emptyValue();
  addPlaceholder(val, { fnId: id, param: 0, rest: true });
  return val;
}

export function evaluatorEvalBinary(
  this: Evaluator,
  node: ts.BinaryExpression,
  ctx: EvalContext,
): AbstractValue {
  const op = node.operatorToken.kind;
  if (op === ts.SyntaxKind.EqualsToken) return handleAssignment(this, node, ctx);
  if (COMPOUND_ASSIGNMENT_OPS.has(op)) return handleCompoundAssignment(this, node, ctx);
  if (op === ts.SyntaxKind.CommaToken) {
    // The comma (sequence) operator evaluates its left operand for effect (facade sinks
    // inside it must be visited) and yields the RIGHT operand's value UNCOLLAPSED — the
    // sequence's result IS the right operand, so its field structure is preserved (a
    // later `(f(), box).note` read and comma-aliasing both need that). Previously the
    // comma fell through to the value-producing default, which collapsed the result
    // and unioned the discarded left operand's taint into it.
    this.evalExpr(node.left, ctx);
    return this.evalExpr(node.right, ctx);
  }
  if (
    op === ts.SyntaxKind.AmpersandAmpersandToken ||
    op === ts.SyntaxKind.BarBarToken ||
    op === ts.SyntaxKind.QuestionQuestionToken
  ) {
    // Short-circuit: the LEFT operand decides whether the right one evaluates, so it is
    // a guard sink — the ordering walk opens a `branch` region over the right operand
    // and reads its controllers off this same node.
    const left = this.evalExpr(node.left, ctx);
    this.recordGuard(node.left, left);
    return unionValues(left, this.evalExpr(node.right, ctx));
  }
  // Value-producing operators (concat, arithmetic, comparison): union of operand
  // taints, fields dropped — the result is a primitive.
  return unionValues(
    collapse(this.evalExpr(node.left, ctx)),
    collapse(this.evalExpr(node.right, ctx)),
  );
}

export function evaluatorEvalPropertyAccess(
  this: Evaluator,
  node: ts.PropertyAccessExpression,
  ctx: EvalContext,
): AbstractValue {
  const receiver = this.evalExpr(node.expression, ctx);
  // Field-sensitive read with smear-on-read (readField unions the container's own
  // container-level occurrences); unknown field folds to the whole-value read.
  return readField(receiver, node.name.text);
}

export function evaluatorEvalElementAccess(
  this: Evaluator,
  node: ts.ElementAccessExpression,
  ctx: EvalContext,
): AbstractValue {
  const receiver = this.evalExpr(node.expression, ctx);
  const literalKey = staticIndexKey(node.argumentExpression);
  if (literalKey !== undefined) return readField(receiver, literalKey);
  // Computed index: evaluate the key for effect (a facade sink can sit in it, e.g.
  // `o[await ask()]`); its taint is NOT joined into the read value — the value stored at a
  // key does not textually contain the key, same convention as a ternary condition. THE
  // widening rule: whole-container read, exactness cleared.
  this.evalExpr(node.argumentExpression, ctx);
  return clearExact(collapse(receiver));
}

export function evaluatorReceiverSymbol(
  this: Evaluator,
  expr: ts.Expression,
): ts.Symbol | undefined {
  return ts.isIdentifier(expr) ? this.checker.getSymbolAtLocation(expr) : undefined;
}
