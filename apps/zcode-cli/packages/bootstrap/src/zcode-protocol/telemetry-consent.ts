// Modified by ZCode Feiyu contributors (2026).
import { zcodeWorkspaceUpdateTelemetryConsentParamsSchema } from "@zcode/shared";
import { setPreparedModelTelemetryEnabled } from "@zcode/telemetry";
import { parseParams } from "./server-types.js";

export async function updateTelemetryConsent(rawParams: unknown) {
  const params = parseParams(zcodeWorkspaceUpdateTelemetryConsentParamsSchema, rawParams);
  await setPreparedModelTelemetryEnabled(params.enabled);
  return { workspace: params.workspace, enabled: params.enabled };
}
