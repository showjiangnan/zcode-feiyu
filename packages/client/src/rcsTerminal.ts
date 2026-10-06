import type { ITerminalService, TerminalChunk } from "@zcode/services";

/** 浏览器刷新只重新 attach；PTY 生命周期仍由桌面 Host 管理。 */
export function createRcsTerminalService(source: ITerminalService): ITerminalService {
  const claimed = new Set<string>();
  return {
    list: source.list ? () => source.list!() : undefined,
    attach: source.attach ? (params) => source.attach!(params) : undefined,
    detach: source.detach ? (params) => source.detach!(params) : undefined,
    onDynamicReplayData: source.onDynamicReplayData
      ? (id) => source.onDynamicReplayData!(id)
      : undefined,
    async create(params) {
      if (source.list && source.attach) {
        const existing = (await source.list()).find(
          (item) => item.cwd === params.cwd && !claimed.has(item.id),
        );
        if (existing) {
          claimed.add(existing.id);
          return source.attach({ id: existing.id, afterSequence: 0 });
        }
      }
      const created = await source.create(params);
      claimed.add(created.id);
      return created;
    },
    write: (params) => source.write(params),
    resize: (params) => source.resize(params),
    dispose: async (params) => {
      claimed.delete(params.id);
      try {
        await source.dispose(params);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !/DEVICE_OFFLINE|channel.*closed|disposed/i.test(error.message)
        )
          throw error;
      }
    },
    onDynamicExit: (id) => source.onDynamicExit(id),
    onDynamicData: (id) => (listener) => {
      if (!source.attach || !source.onDynamicReplayData) return source.onDynamicData(id)(listener);
      let disposed = false;
      let ready = false;
      let sequence = 0;
      const pending: TerminalChunk[] = [];
      const emit = (chunk: TerminalChunk) => {
        if (disposed || chunk.sequence <= sequence) return;
        sequence = chunk.sequence;
        listener(chunk.data);
      };
      // 先订阅再获取回放，缓冲屏障期间的 live 输出，避免快照与订阅之间丢字节。
      const subscription = source.onDynamicReplayData(id)((chunk) => {
        if (ready) emit(chunk);
        else pending.push(chunk);
      });
      void source
        .attach({ id, afterSequence: 0 })
        .then((snapshot) => {
          if (disposed) return;
          if (snapshot.truncated) listener("\r\n[Earlier terminal output has expired]\r\n");
          [...snapshot.chunks, ...pending].sort((a, b) => a.sequence - b.sequence).forEach(emit);
          pending.length = 0;
          ready = true;
        })
        .catch(() => {
          subscription.dispose();
        });
      return {
        dispose() {
          disposed = true;
          pending.length = 0;
          subscription.dispose();
        },
      };
    },
  };
}
