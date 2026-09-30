// Modified by ZCode Feiyu contributors (2026).
import { createHash } from "node:crypto";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
/** 客户端时间、revision 与 trace 不参与载荷身份；因果上下文是运行时事实。 */
export function commandRequestFingerprint(envelope: CommandEnvelope): string {
  const payload = { ...(envelope.payload as Record<string, unknown>) } as Record<string, unknown>;
  delete payload.causalContext;
  return createHash("sha256")
    .update(
      JSON.stringify(
        { type: envelope.type, sessionId: envelope.sessionId, payload },
        (_key, value: unknown) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
            : value,
      ),
    )
    .digest("hex");
}
