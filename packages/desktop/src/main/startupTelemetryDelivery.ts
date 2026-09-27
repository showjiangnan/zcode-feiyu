type DeliveryStatus = "http_received" | "unconfirmed";
const REQUEST_TIMEOUT_MS = 15_000;

/** 装饰 SDK 的公开 reporter.request：仍使用原过滤/采样/序列化，不另发裸 HTTP。 */
export function wrapStartupReporterRequest<C, B extends { events?: unknown[] }>(
  request: (context: C, bundle: B) => unknown,
  options: {
    acknowledged: (ids: string[], status: DeliveryStatus) => void;
    delay?: (ms: number) => Promise<void>;
  },
): (context: C, bundle: B) => Promise<unknown> {
  const delay = options.delay ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async (context, bundle) => {
    const ids = (bundle.events ?? []).flatMap((event) => {
      const id = (event as { properties?: { startup_event_id?: unknown } })?.properties
        ?.startup_event_id;
      return typeof id === "string" ? [id] : [];
    });
    if (ids.length === 0) return request(context, bundle);
    const report = (status: DeliveryStatus) => {
      try {
        options.acknowledged(ids, status);
      } catch {
        /* 诊断出口故障不递归报告。 */
      }
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        const response = await Promise.race([
          Promise.resolve().then(() => request(context, bundle)),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              reject(new Error("Startup telemetry request timeout"));
            }, REQUEST_TIMEOUT_MS);
          }),
        ]);
        if (response && typeof response === "object" && "ok" in response && response.ok === true) {
          report("http_received");
          return response;
        }
      } catch {
        /* 仅遥测网络重试；绝不调用启动协调器或数据库。 */
      } finally {
        if (timer) clearTimeout(timer);
      }
      // SDK 未暴露 AbortSignal。未结束的请求不再复制，避免超时叠加连接；只记未确认。
      if (timedOut) break;
      if (attempt < 2) await delay(500 * 3 ** attempt);
    }
    report("unconfirmed");
    return undefined;
  };
}
