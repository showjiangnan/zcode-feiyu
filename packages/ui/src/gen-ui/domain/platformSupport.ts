// Modified by ZCode Feiyu.
import { isRemoteWorkspaceIdentity } from "@zcode/shared";

export function supportsGenUiSandbox(
  target: {
    workspaceIdentity?: string;
    remoteSessionId?: string;
  },
  sandboxAvailable: boolean,
): boolean {
  // 原生页面只服务本地 Host；远程路径和公网附着不能借用桌面沙箱伪装支持。
  return (
    sandboxAvailable &&
    !target.remoteSessionId &&
    !isRemoteWorkspaceIdentity(target.workspaceIdentity?.trim() ?? "")
  );
}
