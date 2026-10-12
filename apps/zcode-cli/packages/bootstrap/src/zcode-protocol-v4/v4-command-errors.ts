// Modified by ZCode Feiyu.
// 命令错误属于叶子合同，避免 handler 为错误类型反向加载 Gateway owner。
/** 宿主 executor 对未接线命令抛出此错误 → ACK failed fault.notImplemented。 */
export class V4CommandNotImplementedError extends Error {
  constructor(type: string) {
    super(`v4 command not implemented in M3: ${type}`);
    this.name = "V4CommandNotImplementedError";
  }
}

/**
 * 命令 handler 的 noop 收口通道（「同值切换 ACK 必须可判别」）：
 * handler 判定命令无事可做（如 switchModelConfig/switchCollaborationMode 命中
 * runtime 当前值）时抛出，gateway 映射为 ACK status="noop" + reasonCode——
 * 不得以 accepted（无 result）静默吞掉，客户端才能区分「已生效」与「本来就是这个值」。
 */
export class V4CommandNoopError extends Error {
  constructor(
    readonly reasonCode: string,
    message?: string,
  ) {
    super(message ?? `v4 command is a no-op (${reasonCode})`);
    this.name = "V4CommandNoopError";
  }
}
