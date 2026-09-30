// Modified by ZCode Feiyu contributors (2026).
import { SessionEventType, type TraceContext } from "@zcode/contracts";
import { titleFromInput } from "../helpers/project.js";
import type { AgentRuntimeInternal } from "../internal.js";

/** 首输入命名仍属于 Core 持久化入口；预持久空会话不能因为 resume 标记而永久保留占位标题。 */
export async function persistFirstInputTitle(
  runtime: AgentRuntimeInternal,
  input: string,
  traceContext: TraceContext,
): Promise<void> {
  if (!input.trim() || runtime.turnNumber > 0 || !runtime.sessionStore) return;
  const store = runtime.sessionStore;
  const session = await store.getSession(runtime.sessionId);
  if (!session || session.titleSource !== "default") return;
  if ((await store.messages({ sessionID: runtime.sessionId })).length > 0) return;
  const title = titleFromInput(input);
  // 不以占位字符串识别状态；first_input/custom/generated 都是已命名事实。
  // 复用既有 titleSource CAS，读取后发生的用户改名不能被首输入覆盖。
  const updated = await store.updateSession({
    id: runtime.sessionId,
    expectedTitleSources: ["default"],
    title,
    titleSource: "first_input",
  });
  if (updated.title !== title || updated.titleSource !== "first_input") return;
  await runtime.appendEvent(
    runtime.createEvent(
      SessionEventType.SessionTitleUpdated,
      {
        previousTitle: session.title,
        source: "first_input",
        title,
      },
      traceContext,
    ),
    traceContext,
  );
}
