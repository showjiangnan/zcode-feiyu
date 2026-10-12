// Modified by ZCode Feiyu.
import ts from "typescript";

import { emptyValue, isFunctionLike } from "./domain.js";

import type { TaintState } from "./state.js";

export function taintStateBuildLookups(this: TaintState): void {
  for (const site of this.table.asks) {
    this.askByCall.set(site.call, site.id);
    this.askSites.set(site.id, { instructions: site.instructions, receiver: site.receiver });
  }
  for (const site of this.table.worldReads)
    this.worldByCall.set(site.call, { args: site.args, id: site.id });
  for (const site of this.table.joins)
    this.joinByCall.set(site.call, { arg: site.arg, id: site.id });
  for (const site of this.table.actors) this.actorByCall.set(site.call, site.id);
  for (const site of this.table.holes) this.holeByCall.set(site.call, site);
  for (const cand of this.table.iterations) {
    if (cand.form === "array-method" && cand.call !== undefined) {
      this.candByCall.set(cand.call, cand);
      // An inline callback literal is evaluated in place (array-methods.ts), never as a
      // tracked function; a non-literal callback's functions are tracked and applied.
      if (cand.callback !== undefined) this.callbackNodes.add(cand.callback);
    } else if (cand.form === "for-of") {
      // candidate.body === ForOfStatement.statement, so body.parent is the for-of.
      this.candByForOf.set(cand.body.parent, cand);
    }
  }
}

export function taintStateCollectFunctions(this: TaintState): void {
  const visit = (node: ts.Node): void => {
    // One shared abstract instance per class (declaration or expression); constructors,
    // methods and accessors are collected as tracked functions below (isFunctionLike
    // covers them), so their bodies get summaries like any other function.
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      this.classInstances.set(node, emptyValue());
      this.classes.push(node);
    }
    if (isFunctionLike(node) && !this.callbackNodes.has(node)) {
      const id = this.functions.length;
      this.fnId.set(node, id);
      this.functions.push(node);
      const decl = node as ts.SignatureDeclaration;
      this.fnParamSymbols.set(
        id,
        decl.parameters.map((p) =>
          ts.isIdentifier(p.name) ? this.checker.getSymbolAtLocation(p.name) : undefined,
        ),
      );
      // Object-literal set accessor: index it by property name so property writes
      // can feed the setter's param (see settersByProp).
      if (ts.isSetAccessorDeclaration(node) && !ts.isComputedPropertyName(node.name)) {
        const name = node.name.getText(this.scriptFile);
        const list = this.settersByProp.get(name);
        if (list === undefined) this.settersByProp.set(name, [id]);
        else list.push(id);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const stmt of this.body.statements) visit(stmt);
}
