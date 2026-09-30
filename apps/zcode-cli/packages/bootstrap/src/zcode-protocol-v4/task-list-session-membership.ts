// Modified by ZCode Feiyu contributors (2026).
import { isTaskRoot, SESSION_TASK_ROOT_TYPES, type SessionTaskType } from "@zcode/contracts";

/** fork 虽有 parent 仍是主任务；同一类型事实也约束 Core 主动工作和预算归属。 */
export const TASK_LIST_SESSION_TYPES = SESSION_TASK_ROOT_TYPES;

export function isTaskListSessionType(taskType: SessionTaskType | undefined): boolean {
  return isTaskRoot(taskType);
}
