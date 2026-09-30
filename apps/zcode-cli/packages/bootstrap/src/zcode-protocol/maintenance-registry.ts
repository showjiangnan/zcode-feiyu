// Modified by ZCode Feiyu contributors (2026).
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";
import type { ZCodeApp } from "../app/types.js";

const maintenanceApps = new WeakMap<ZCodeProtocolAgentServerContext, Map<string, ZCodeApp>>();
export function getWorkspaceMaintenanceApps(
  context: ZCodeProtocolAgentServerContext,
): Map<string, ZCodeApp> {
  let apps = maintenanceApps.get(context);
  if (!apps) {
    apps = new Map();
    maintenanceApps.set(context, apps);
  }
  return apps;
}
