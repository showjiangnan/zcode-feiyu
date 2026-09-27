import { NodeExecutionAdapterLifecycle } from "./node-execution-adapter-lifecycle.js";
import type { NodeExecutionAdapterOptions } from "./execution-adapter-types.js";
import type { ExecutionPort } from "@zcode/contracts";

export class NodeExecutionAdapter extends NodeExecutionAdapterLifecycle implements ExecutionPort {}

export function createNodeExecutionAdapter(
  options: NodeExecutionAdapterOptions = {},
): ExecutionPort {
  return new NodeExecutionAdapter(options);
}
