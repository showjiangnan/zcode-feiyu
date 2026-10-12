// Modified by ZCode Feiyu.
/** 启动和清理共用首因裁决，falsy 异常也不能被后续 close 覆盖。 */
export async function runWithStorageCleanup<Value>(
  work: () => Promise<Value>,
  cleanup: readonly (() => void)[],
): Promise<Value> {
  let outcome: { ok: true; value: Value } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await work() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  for (const close of cleanup) {
    try {
      close();
    } catch (error) {
      if (outcome.ok) outcome = { ok: false, error };
    }
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
