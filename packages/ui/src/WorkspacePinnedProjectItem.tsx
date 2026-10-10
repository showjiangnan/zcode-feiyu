// Modified by ZCode Feiyu contributors (2026).
import { memo, useCallback, useState, type ComponentProps } from "react";
import { WorkspaceSidebarItem } from "@/WorkspaceSidebarItem.js";

type PinnedProjectProps = Omit<
  ComponentProps<typeof WorkspaceSidebarItem>,
  "isExpanded" | "pinnedShortcut" | "onPinnedExpandedChange" | "onShowMoreTasks"
> & {
  workspaceKey: string;
  onShowMoreWorkspaceTasks: (workspaceKey: string) => void;
};

export const WorkspacePinnedProjectItem = memo(function WorkspacePinnedProjectItem({
  workspaceKey,
  onShowMoreWorkspaceTasks,
  ...props
}: PinnedProjectProps) {
  // 同一项目的两个位置共享任务数据，展开状态属于各自 UI；取消置顶卸载后恢复默认折叠。
  const [expanded, setExpanded] = useState(false);
  const handleExpandedChange = useCallback(
    (_key: string, value: boolean) => setExpanded(value),
    [],
  );
  const handleShowMore = useCallback(
    () => onShowMoreWorkspaceTasks(workspaceKey),
    [onShowMoreWorkspaceTasks, workspaceKey],
  );
  return (
    <WorkspaceSidebarItem
      {...props}
      pinnedShortcut
      isExpanded={expanded}
      onPinnedExpandedChange={handleExpandedChange}
      onShowMoreTasks={handleShowMore}
    />
  );
});
