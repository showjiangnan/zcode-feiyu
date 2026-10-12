// Modified by ZCode Feiyu.
// 按职责拆分实现，公开入口保持不变；所有状态仍归同一个 runtime 所有。
export {
  hasRunningBackgroundTasks,
  cancelBackgroundTask,
  stopBackgroundTask,
  cancelRunningRuntimeBackgroundTasks,
} from "./background-stop.js";
export { buildBackgroundTaskPayload } from "./background-projection.js";
export type {
  RuntimeBackgroundStopOptions,
  RuntimeBackgroundStopResult,
} from "./background-stop-types.js";
