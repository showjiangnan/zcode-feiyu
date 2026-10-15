// Modified by ZCode Feiyu.
import { join, relative } from "node:path";
import type { ExternalImportResource, ExternalImportSelection } from "@zcode/shared";
import { importPathIdentity } from "../domain/identity.js";
import { digest } from "./sourceFiles.js";
export function importResourceTarget(
  resource: ExternalImportResource,
  selection: ExternalImportSelection,
): string {
  const target = resource.workspacePath && selection.workspaceMappings?.[resource.workspacePath];
  return target
    ? join(target, relative(resource.workspacePath!, resource.targetPath))
    : resource.targetPath;
}
export function resourceMappingKey(
  resource: ExternalImportResource,
  selection: ExternalImportSelection,
): string {
  return digest(
    `${resource.key}:${importPathIdentity(importResourceTarget(resource, selection), process.platform)}`,
  );
}
