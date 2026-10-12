// Modified by ZCode Feiyu.
import ts from "typescript";

import {
  addOcc,
  collapse,
  emptyValue,
  isActorSite,
  mergeInto,
  phKey,
  provisionalFanoutId,
  type AbstractValue,
  type Placeholder,
  type PromotedFanout,
  type TaintFacts,
  type TaintOcc,
} from "./domain.js";

import type { ApplicationVia, TaintState } from "./state.js";

// -- emission ------------------------------------------------------------

export function taintStateEmitFacts(this: TaintState): TaintFacts {
  const askData = new Map<string, TaintOcc[]>();
  const askActor = new Map<string, TaintOcc[]>();
  const worldReadData = new Map<string, TaintOcc[]>();
  const joinIn = new Map<string, TaintOcc[]>();
  const fanoutIn = new Map<string, TaintOcc[]>();

  for (const [id, value] of this.askInstr) askData.set(id, this["resolveArtifact"](value));
  for (const [id, value] of this.askRecv) askActor.set(id, this["resolveActor"](value));
  for (const [id, value] of this.worldRead) worldReadData.set(id, this["resolveArtifact"](value));
  const holeData = new Map<string, TaintOcc[]>();
  for (const [id, value] of this.holePrompt) holeData.set(id, this["resolveArtifact"](value));
  for (const [id, ports] of this.joinInByPort) {
    const occs: TaintOcc[] = [];
    for (const [port, value] of ports) {
      for (const occ of this["resolveArtifact"](value)) {
        occs.push({ exact: occ.exact, site: occ.site, ...(port >= 0 ? { port } : {}) });
      }
    }
    joinIn.set(id, occs);
  }
  for (const [id, value] of this.fanoutInVal) fanoutIn.set(id, this["resolveArtifact"](value));

  const promoted: PromotedFanout[] = this.table.iterations
    .filter((cand) => this.promotedOrders.has(cand.order))
    .sort((a, b) => a.order - b.order)
    .map((cand) => ({
      id: provisionalFanoutId(cand.order),
      label: "fan-out",
      loc: cand.loc,
      order: cand.order,
    }));

  return {
    askActor,
    askData,
    fanoutIn,
    holeData,
    joinIn,
    promoted,
    returnData: this["resolveArtifact"](this.returnVal),
    worldReadData,
  };
}

/**
 * The ordering walk's oracle view, resolved directly off the CONVERGED interpreter
 * state — the fused pass's replacement for the `awaitSettles`/`guardReads` members
 * TaintFacts used to carry.
 * Same keying (`node.getStart(scriptFile)` of the awaited/guard expression) and the
 * SAME resolution pipeline as every artifact sink (placeholders expanded, collapsed,
 * actor labels filtered) — so an awaited parameter still resolves to the union of the
 * promises its callers passed in, across all call sites. That union is normative: the
 * temporal walk must see today's context-INsensitive values bit-for-bit; caller-context
 * precision is explicitly out of scope.
 *
 * Only meaningful after the fixpoint has converged; interpret.ts is the one caller.
 */

export function taintStateEmitOracle(this: TaintState): {
  awaitSettles: Map<number, TaintOcc[]>;
  guardReads: Map<number, TaintOcc[]>;
  applications: ReadonlyMap<ts.Node, ReadonlyMap<ts.Node, ApplicationVia>>;
} {
  const awaitSettles = new Map<number, TaintOcc[]>();
  for (const [pos, value] of this.awaitVal) awaitSettles.set(pos, this["resolveArtifact"](value));
  const guardReads = new Map<number, TaintOcc[]>();
  for (const [pos, value] of this.guardVal) guardReads.set(pos, this["resolveArtifact"](value));
  return { applications: this.applications, awaitSettles, guardReads };
}

export function taintStateResolveArtifact(this: TaintState, value: AbstractValue): TaintOcc[] {
  return this["resolveOccs"](value).filter((occ) => !isActorSite(occ.site));
}

export function taintStateResolveActor(this: TaintState, value: AbstractValue): TaintOcc[] {
  return this["resolveOccs"](value).filter((occ) => isActorSite(occ.site));
}

export function taintStateResolveOccs(this: TaintState, value: AbstractValue): TaintOcc[] {
  return [...collapse(this["resolvePlaceholders"](value, new Set())).occs.values()];
}

/** Expand parameter placeholders to the union of actual arguments across all calls. */

export function taintStateResolvePlaceholders(
  this: TaintState,
  value: AbstractValue,
  visiting: Set<string>,
  seen = new Set<AbstractValue>(),
): AbstractValue {
  if (seen.has(value)) return emptyValue(); // cycle-safe: a shared field contributes once
  seen.add(value);
  const out = emptyValue();
  for (const occ of value.occs.values()) addOcc(out, occ);
  for (const ph of value.phs.values()) this["resolvePlaceholder"](out, ph, visiting);
  for (const [key, field] of value.fields)
    out.fields.set(key, this["resolvePlaceholders"](field, visiting, seen));
  // A bound function reaching an emission point (e.g. a returned bound function) must not
  // drop its prefix's taint; fold each resolved prefix arg in (collapsed at emission).
  for (const el of value.bound ?? [])
    mergeInto(out, this["resolvePlaceholders"](el, visiting, seen));
  return out;
}

export function taintStateResolvePlaceholder(
  this: TaintState,
  out: AbstractValue,
  ph: Placeholder,
  visiting: Set<string>,
): void {
  if (ph.rest === true) {
    // A rest formal gathers every actual recorded at index >= ph.param (calls
    // record actuals positionally, so a rest param has many keyed slots).
    for (const [key, actual] of this.paramActuals) {
      const sep = key.indexOf(":");
      if (Number(key.slice(0, sep)) !== ph.fnId || Number(key.slice(sep + 1)) < ph.param) continue;
      if (visiting.has(key)) continue;
      visiting.add(key);
      mergeInto(out, this["resolvePlaceholders"](actual, visiting));
      visiting.delete(key);
    }
    return;
  }
  const key = phKey(ph);
  if (visiting.has(key)) return; // recursion → bottom
  const actual = this.paramActuals.get(key);
  if (actual === undefined) return;
  visiting.add(key);
  mergeInto(out, this["resolvePlaceholders"](actual, visiting));
  visiting.delete(key);
}
