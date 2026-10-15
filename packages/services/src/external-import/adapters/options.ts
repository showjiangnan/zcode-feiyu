// Modified by ZCode Feiyu.
import type { ExternalImportSessionPort } from "../contract.js";
export interface ImportOwnerOptions {
  supported: boolean;
  directory: string;
  targetRoot: string;
  sessionPort: ExternalImportSessionPort;
  registerProjects: (paths: string[]) => Promise<void>;
  intervalMs?: number;
}
