// Modified by ZCode Feiyu.
export interface ComputerControlContext {
  sessionId: string;
  turnId: string;
  workspaceKey: string;
  workspaceIdentity?: string;
  workspacePath?: string;
  runtimeScope: "main";
}
export interface ComputerControlPort {
  execute(
    method: string,
    input: Record<string, unknown>,
    context: ComputerControlContext,
    signal?: AbortSignal,
  ): Promise<unknown>;
  stop(context: ComputerControlContext): Promise<void>;
  dispose(): Promise<void>;
}
