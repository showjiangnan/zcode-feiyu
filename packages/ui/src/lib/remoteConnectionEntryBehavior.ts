// Modified by ZCode Feiyu.
type SidebarOpenWorkspaceAction = "open-workspace";

export function resolveSidebarOpenWorkspaceAction(_params: {
  remoteConnectionInProgress: boolean;
}): SidebarOpenWorkspaceAction {
  return "open-workspace";
}
