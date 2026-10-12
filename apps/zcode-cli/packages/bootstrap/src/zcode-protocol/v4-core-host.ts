// Modified by ZCode Feiyu.
import type { V4CoreHostInput } from "./v4-core-host-types.js";
import { createV4CoreInput } from "./v4-core-input.js";
import { createV4CoreFork } from "./v4-core-fork.js";
import { createV4CoreRows } from "./v4-core-rows.js";

import type { V4CommandCoreHost } from "../zcode-protocol-v4/commands/types.js";

// 装配阶段复用同一实例与闭包，不另建运行状态或副作用路径。
export function createV4CoreHost(input: V4CoreHostInput) {
  const { context, queuedTurnExecutions } = input;

  const coreHost: V4CommandCoreHost = {
    // 同一注册表对象引用：view 是旧 record 的结构化窄视图，字段变更双向可见。
    getRecord: (sessionId) => context.sessions.get(sessionId),

    // 同一登记表实例：broker（旧目录）注册反向请求 deferred，
    // v4 resolveInteraction handler 经此投递应答（v4 原生基础设施，非过渡钩子）。
    interactions: context.v4Interactions,

    logger: {
      info: (message, fields) => context.logger?.info(message, fields),
      warn: (message, fields) => context.logger?.warn(message, fields),
    },

    // v4 原生能力（非过渡钩子）：sendQueuedNow 必须读取 v4 投影里的完整 intent。
    // 命令执行时 context.v4Gateway 已由 server 注入（createConversationV4Gateway
    // 返回值回填），这里惰性取用避免构造期自引用。
    getQueueItem: (sessionId, queueItemId) =>
      context.v4Gateway?.getQueueItem(sessionId, queueItemId) ?? null,

    hasQueueItemKind: (sessionId, kind) =>
      context.v4Gateway?.hasQueueItemKind(sessionId, kind) ?? false,

    hasQueuedDelivery: (sessionId, delivery) =>
      context.v4Gateway?.hasQueuedDelivery(sessionId, delivery) ?? false,

    getQueueLength: (sessionId) => context.v4Gateway?.getQueueLength(sessionId) ?? 0,

    retainQueuedTurnExecution: (sessionId, sourceCommandId, execution) => {
      const sessionExecutions = queuedTurnExecutions.get(sessionId) ?? new Map();
      sessionExecutions.set(sourceCommandId, execution);
      queuedTurnExecutions.set(sessionId, sessionExecutions);
    },

    readQueuedTurnExecution: (sessionId, sourceCommandId) =>
      queuedTurnExecutions.get(sessionId)?.get(sourceCommandId),

    deleteQueuedTurnExecution: (sessionId, sourceCommandId) => {
      const sessionExecutions = queuedTurnExecutions.get(sessionId);
      sessionExecutions?.delete(sourceCommandId);
      if (sessionExecutions?.size === 0) queuedTurnExecutions.delete(sessionId);
    },

    clearQueuedTurnExecutions: (sessionId) => {
      queuedTurnExecutions.delete(sessionId);
    },

    waitForProjectionEventCommit: (sessionId, eventId, options) => {
      const gateway = context.v4Gateway;
      if (!gateway) {
        return Promise.reject(new Error("v4 gateway unavailable for projection commit wait"));
      }
      return gateway.waitForProjectionEventCommit(sessionId, eventId, options);
    },
    ...createV4CoreInput(input),
    ...createV4CoreRows(input),
    ...createV4CoreFork(input),
  };
  return { coreHost };
}
