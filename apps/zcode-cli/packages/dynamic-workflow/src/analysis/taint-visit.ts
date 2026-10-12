// Modified by ZCode Feiyu.
import ts from "typescript";

import { cloneValue, collapse, emptyValue } from "./domain.js";

import { handleForIn, handleForOf, visitForStatement } from "./control-flow.js";

import type { EvalContext, Evaluator } from "./taint.js";

// -- statement visitor ---------------------------------------------------

export function evaluatorVisit(this: Evaluator, node: ts.Node, ctx: EvalContext): void {
  if (ts.isVariableStatement(node)) {
    for (const decl of node.declarationList.declarations) this.handleDeclaration(decl, ctx);
  } else if (ts.isExpressionStatement(node)) {
    this.evalExpr(node.expression, ctx);
  } else if (ts.isReturnStatement(node)) {
    ctx.onReturn(
      node.expression === undefined ? emptyValue() : this.evalExpr(node.expression, ctx),
    );
  } else if (ts.isForOfStatement(node)) {
    handleForOf(this, node, ctx);
  } else if (ts.isIfStatement(node)) {
    this.recordGuard(node.expression, this.evalExpr(node.expression, ctx));
    this.visit(node.thenStatement, ctx);
    if (node.elseStatement !== undefined) this.visit(node.elseStatement, ctx);
  } else if (ts.isBlock(node)) {
    for (const stmt of node.statements) this.visit(stmt, ctx);
  } else if (ts.isForStatement(node)) {
    visitForStatement(this, node, ctx);
  } else if (ts.isForInStatement(node)) {
    handleForIn(this, node, ctx);
  } else if (ts.isWhileStatement(node)) {
    // A `while` condition decides whether the body runs at all, so it is a guard sink.
    this.recordGuard(node.expression, this.evalExpr(node.expression, ctx));
    this.visit(node.statement, ctx);
  } else if (ts.isDoStatement(node)) {
    // Split out of the shared while/do arm deliberately: a `do…while` body is
    // unconditional on first entry, so its condition guards nothing and must NOT be
    // recorded. Same fact that makes that region `entered` in the ordering walk. Evaluation order is unchanged.
    this.evalExpr(node.expression, ctx);
    this.visit(node.statement, ctx);
  } else if (ts.isSwitchStatement(node)) {
    // Recorded ONCE on the switch expression, not per clause: the ordering walk opens a
    // branch region per clause but reads every one of their controllers off this node.
    this.recordGuard(node.expression, this.evalExpr(node.expression, ctx));
    for (const clause of node.caseBlock.clauses) {
      if (ts.isCaseClause(clause)) this.evalExpr(clause.expression, ctx);
      for (const stmt of clause.statements) this.visit(stmt, ctx);
    }
  } else if (ts.isTryStatement(node)) {
    this.visit(node.tryBlock, ctx);
    if (node.catchClause !== undefined) {
      // Every catch binding reads the whole script-global thrown-value set (a clone
      // each pass so binding stays monotone). Previously the catch variable was never
      // bound, so throw→catch dataflow (and any read of the caught value) was lost.
      const vd = node.catchClause.variableDeclaration;
      if (vd !== undefined) this.bindPattern(vd.name, cloneValue(this.s.thrownVal), ctx);
      this.visit(node.catchClause.block, ctx);
    }
    if (node.finallyBlock !== undefined) this.visit(node.finallyBlock, ctx);
  } else if (ts.isThrowStatement(node)) {
    // `throw e` joins collapse(e) into the global thrown set.  ThrowStatement
    // was absent from the visitor, so its subexpression's facade sites (e.g. an
    // `agent().ask()` in the thrown value) were never evaluated at all.
    this.s.mergeThrown(collapse(this.evalExpr(node.expression, ctx)));
  } else if (ts.isLabeledStatement(node)) {
    this.visit(node.statement, ctx);
  }
  // Function/class declarations carry no top-level dataflow here: functions are
  // evaluated in their own pass and their names are pre-bound (hoisting).
}

export function evaluatorHandleDeclaration(
  this: Evaluator,
  decl: ts.VariableDeclaration,
  ctx: EvalContext,
): void {
  if (decl.initializer === undefined) return;
  // Aliasing binding: `const alias = box` / `const b = arr[0]` bind the symbol to the
  // LIVE value the place denotes (shared reference), so a later write through any
  // alias is visible through the original. Destructuring off a place aliases each
  // extracted element to a live field (see bindPattern). Non-place RHS keeps value
  // semantics.
  const place = this.resolvePlace(decl.initializer);
  if (ts.isIdentifier(decl.name)) {
    if (place !== undefined) {
      const sym = this.checker.getSymbolAtLocation(decl.name);
      if (sym !== undefined) {
        // Evaluate the initializer for its side effects before aliasing: a place peeled
        // out of a comma (`(f(), box)`) or an `await` discards operands / a thenable's
        // `then` whose facade sinks must still be visited. For the plain place forms
        // (identifier / static field chain) this is a graph no-op (reads emit no sinks).
        this.evalExpr(decl.initializer, ctx);
        this.s.bindSymbol(sym, place);
        return;
      }
    }
    this.bindPattern(decl.name, this.evalExpr(decl.initializer, ctx), ctx);
    return;
  }
  // Destructuring off a live place aliases each extracted element to a live field. When the
  // place is present, still evaluate the initializer for effect (a join's edges, an awaited
  // thenable's `then`) — the alias binds to the place, not the discarded snapshot.
  // `const [sec, alias] = await Promise.all([secret, box])` needs both the join edges AND
  // the element aliasing (alias IS box) so a write through `alias` reaches box.
  if (place !== undefined) {
    this.evalExpr(decl.initializer, ctx);
    this.bindPattern(decl.name, place, ctx, place);
    return;
  }
  this.bindPattern(decl.name, this.evalExpr(decl.initializer, ctx), ctx);
}
