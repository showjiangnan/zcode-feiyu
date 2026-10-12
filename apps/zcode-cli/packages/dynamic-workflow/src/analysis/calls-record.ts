// Modified by ZCode Feiyu.
import ts from "typescript";
import {
  addOcc,
  addPlaceholder,
  clearExact,
  collapse,
  collapseInto,
  emptyValue,
  mergeBound,
  mergeInto,
  VALUE_DEPTH_CAP,
  type AbstractValue,
} from "./domain.js";
import type { Evaluator } from "./taint.js";
import type { ApplicationVia } from "./state.js";

export function recordCall(
  ev: Evaluator,
  id: number,
  regionStack: string[],
  argVals: AbstractValue[],
  argPlaces?: (AbstractValue | undefined)[],
  application?: { site: ts.Node; via: ApplicationVia },
): void {
  ev.s.markCalled(regionStack, id);
  if (application !== undefined) {
    const fn = ev.s.functions[id];
    if (fn !== undefined) ev.s.recordApplication(application.site, fn, application.via);
  }
  const params = ev.s.fnParamSymbols.get(id) ?? [];
  argVals.forEach((argVal, param) => {
    ev.s.addParamActual(id, param, argVal);
    // Keep the call graph total through parameters: functions passed as arguments
    // must be reachable as callees inside the body.
    const psym = params[param];
    if (psym !== undefined && argVal.fns.size > 0) {
      const fnsOnly = emptyValue();
      for (const fn of argVal.fns) fnsOnly.fns.add(fn);
      ev.s.bindSymbol(psym, fnsOnly);
    }
    // Parameter write-back: objects cross call boundaries by reference, so a field the
    // callee wrote through the parameter (`box.f = tainted`) must be visible through the
    // caller's argument. Weak-merge the parameter's accumulated heap effects back into
    // the actual's live value when the actual is a place. Monotone; converges with the
    // fixpoint. The parameter's own top-level placeholder is skipped — merging it back
    // would just resolve (guarded) to the actual itself, adding nothing.
    const actualLive = argPlaces?.[param];
    if (psym !== undefined && actualLive !== undefined) {
      const paramSlot = ev.s.env.get(psym);
      if (
        paramSlot !== undefined &&
        paramSlot !== actualLive &&
        mergeHeapEffects(actualLive, paramSlot, id, param, argVals)
      ) {
        ev.s.changed = true;
      }
    }
  });
}

/**
 * Merge a callee parameter's heap effects (its occurrences + fields, recursively) into
 * a caller actual, skipping the parameter's OWN top-level placeholder. Field writes land
 * in `fields`; in-place mutators (`push`, `Map.set`) fold into `occs` — both propagate.
 * The own placeholder is the parameter's identity, not a written effect, so it is not
 * carried back (it would resolve to the actual itself at emission).
 *
 * OTHER top-level placeholders are written effects and must flow: an in-place mutator
 * routes sibling params into the receiver's top level (`fill(list, v) { list.push(v) }`
 * leaves ph(fill,1) in `list`'s slot), and skipping them meant the caller's array never
 * learned it may contain the pushed value — ask#1 → ask#2 edges through such containers
 * vanished. Same-callee placeholders substitute to THIS call's actuals (context-sensitive,
 * exactly like {@link substitute} does for return summaries; the actuals arrive already
 * exactness-adjusted for the dispatch). A placeholder of an ENCLOSING function carries
 * through raw, resolved in the outer context — mirroring substitute's carry-through arm.
 */
function mergeHeapEffects(
  target: AbstractValue,
  source: AbstractValue,
  fnId: number,
  selfParam: number,
  argVals: AbstractValue[],
): boolean {
  let changed = false;
  for (const occ of source.occs.values()) changed = addOcc(target, occ) || changed;
  for (const ph of source.phs.values()) {
    if (ph.fnId !== fnId) {
      changed = addPlaceholder(target, ph) || changed;
      continue;
    }
    if (ph.param === selfParam) continue; // the parameter's own identity, not an effect
    if (ph.rest === true) {
      // A rest formal gathers every actual at index >= ph.param.
      for (let i = ph.param; i < argVals.length; i += 1) {
        const restActual = argVals[i];
        if (restActual !== undefined) changed = mergeInto(target, collapse(restActual)) || changed;
      }
      continue;
    }
    const actual = argVals[ph.param];
    // collapse matches what the in-place mutator itself folds into the receiver.
    if (actual !== undefined) changed = mergeInto(target, collapse(actual)) || changed;
  }
  for (const fn of source.fns) {
    if (!target.fns.has(fn)) {
      target.fns.add(fn);
      changed = true;
    }
  }
  for (const [key, field] of source.fields) {
    let slot = target.fields.get(key);
    if (slot === undefined) {
      slot = emptyValue();
      target.fields.set(key, slot);
    }
    changed = mergeInto(slot, field) || changed;
  }
  // A parameter carrying a bind prefix, written back through a place actual, keeps it.
  // Routed through the domain's mergeBound rather than duplicating its element-wise loop, so
  // the prefix LENGTH cap applies here too: the write-back target is a persistent place, and
  // an uncapped prefix growing one element per pass never settles (the reason mergeBound caps).
  if (source.bound !== undefined) changed = mergeBound(target, source.bound, 0) || changed;
  return changed;
}

/** The callee's return summary with this call's actual arguments substituted in. */
export function substitute(
  summary: AbstractValue,
  fnId: number,
  argVals: AbstractValue[],
  clear: boolean,
  depth = 0,
): AbstractValue {
  const out = emptyValue();
  for (const occ of summary.occs.values()) {
    addOcc(out, { exact: clear ? false : occ.exact, port: occ.port, site: occ.site });
  }
  for (const ph of summary.phs.values()) {
    if (ph.fnId !== fnId) {
      addPlaceholder(out, ph); // a placeholder of an enclosing function — carry it through
      continue;
    }
    if (ph.rest === true) {
      // A rest formal gathers every actual at index >= ph.param.
      for (let i = ph.param; i < argVals.length; i += 1) {
        const restActual = argVals[i];
        if (restActual !== undefined) mergeInto(out, clear ? clearExact(restActual) : restActual);
      }
      continue;
    }
    const actual = argVals[ph.param];
    if (actual !== undefined) mergeInto(out, clear ? clearExact(actual) : actual);
  }
  for (const fn of summary.fns) out.fns.add(fn);
  // Depth-bounded like the domain merges: beyond the cap, fold nested summary structure
  // into occurrences rather than recursing (keeps this walk finite for deep summaries).
  if (depth >= VALUE_DEPTH_CAP) {
    for (const field of summary.fields.values()) collapseInto(out, field);
    for (const el of summary.bound ?? []) collapseInto(out, el);
    return out;
  }
  // A returned bound function (`function mk(x){ return f.bind(null, x); }`) carries its
  // prefix through the summary; substitute the callee's placeholders inside each prefix arg
  // so `mk(secret)` yields a value whose prefix is `secret`.
  if (summary.bound !== undefined) {
    out.bound = summary.bound.map((el) => substitute(el, fnId, argVals, clear, depth + 1));
  }
  for (const [key, field] of summary.fields)
    out.fields.set(key, substitute(field, fnId, argVals, clear, depth + 1));
  return out;
}
