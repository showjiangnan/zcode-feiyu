// Modified by ZCode Feiyu.
// 按职责拆分实现，公开入口保持不变；所有状态仍归同一个 runtime 所有。
export {
  enqueueRuntimeCommand,
  drainRuntimeCommandQueue,
  hasActiveOrQueuedTurnWork,
  acquireForegroundPromotionLease,
  releaseForegroundPromotionLease,
} from "./runtime-command-queue-admission.js";
export {
  stopActiveForegroundExecution,
  getActiveForegroundExecutionId,
} from "./runtime-command-queue-execution.js";
