// Modified by ZCode Feiyu.
import type { Event } from "@zcode/rpc";
import type {
  ExternalImportDetectRequest,
  ExternalImportDiscovery,
  ExternalImportOperation,
  ExternalImportSelection,
  ExternalImportView,
  ExternalHistoryMessage,
  ExternalImportProvenance,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IExternalImportService {
  getView(): Promise<ExternalImportView>;
  detect(request: ExternalImportDetectRequest): Promise<ExternalImportDiscovery>;
  cancelDetection(requestId: string): Promise<void>;
  execute(request: {
    operationId: string;
    selection: ExternalImportSelection;
  }): Promise<ExternalImportOperation>;
  cancel(operationId: string): Promise<void>;
  configure(request: {
    enabled?: boolean;
    selections?: ExternalImportSelection[];
  }): Promise<ExternalImportView>;
  retry(operationId: string, retryOperationId?: string): Promise<ExternalImportOperation>;
  readonly onDidChange: Event<ExternalImportView>;
}
export const IExternalImportService =
  createServiceDescriptor<IExternalImportService>("external-import");
export interface ExternalImportSessionPort {
  commit(input: {
    sessionId: string;
    workspacePath: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: ExternalHistoryMessage[];
    provenance: ExternalImportProvenance;
  }): Promise<{ taskId: string; workspacePath: string }>;
}
