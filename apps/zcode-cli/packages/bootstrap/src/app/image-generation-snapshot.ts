import { imageGenerationConfigSchema } from "@zcode/shared";
import type { ImageGenerationPort, SessionId, SessionStorePort } from "@zcode/contracts";

export async function restoreImageGenerationPort(
  port: ImageGenerationPort | undefined,
  store: SessionStorePort,
  sessionId: SessionId,
  resume: boolean,
): Promise<ImageGenerationPort | undefined> {
  if (!port || !resume) return port;
  const entries = await store.sessionEntries?.({
    sessionID: sessionId,
    type: "runtime/image_generation",
  });
  const entry = entries?.find((item) => item.sessionID === sessionId);
  // 旧会话没有能力快照时默认关闭；启用设置只能影响新会话，不能给恢复中的旧任务新增付费权限。
  const config = entry
    ? imageGenerationConfigSchema.parse(entry.data)
    : { ...port.config, enabled: false, allowSubagents: false };
  return { ...port, config };
}
