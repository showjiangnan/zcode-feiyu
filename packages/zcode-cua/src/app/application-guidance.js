// Modified by ZCode Feiyu.
import { trustedApplicationGuidance } from "../domain/application-guidance.js";
export function projectApplicationGuidance(owner, key, app, state) {
  if (!state?.observationId) return;
  const guidance = trustedApplicationGuidance(app);
  if (!guidance) return;
  const seen = owner.guidanceSeen.get(key) || new Set();
  const id = `${guidance.id}:${guidance.version}`;
  if (seen.has(id)) return;
  state.appGuidance = guidance;
  seen.add(id);
  owner.guidanceSeen.set(key, seen);
}
