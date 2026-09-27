import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const TELEMETRY_STATE_LOCK_STALE_MS = 5 * 60_000;
const pendingStandaloneDeviceMidByStateFile = new Map<string, Promise<string | undefined>>();

export async function resolveStandaloneDeviceMid(
  zcodeHome: string | undefined,
): Promise<string | undefined> {
  const stateFile = zcodeHome
    ? join(zcodeHome, "v2", "telemetry-state.json")
    : join(homedir(), ".zcode", "v2", "telemetry-state.json");
  const pending = pendingStandaloneDeviceMidByStateFile.get(stateFile);
  if (pending) return pending;
  const resolution = resolveStandaloneDeviceMidFromFile(stateFile);
  pendingStandaloneDeviceMidByStateFile.set(stateFile, resolution);
  try {
    return await resolution;
  } finally {
    if (pendingStandaloneDeviceMidByStateFile.get(stateFile) === resolution) {
      pendingStandaloneDeviceMidByStateFile.delete(stateFile);
    }
  }
}

async function resolveStandaloneDeviceMidFromFile(stateFile: string): Promise<string | undefined> {
  try {
    const existing = await readDeviceMid(stateFile);
    if (existing) return existing;
    return await withTelemetryStateLock(stateFile, async () => {
      const state = await readTelemetryState(stateFile);
      const lockedExisting = deviceMidFromState(state);
      if (lockedExisting) return lockedExisting;
      const deviceMid = randomUUID();
      state.deviceMid = deviceMid;
      const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
      await rename(temporary, stateFile);
      return deviceMid;
    });
  } catch {
    // Bug 根因：Telemetry 身份过去在同步工厂里直接做文件 I/O，慢盘会阻塞 CLI 启动；
    // 异步准备仍必须保持旁路，读写失败只缺少匿名关联，不能影响 Agent 主链路。
    return undefined;
  }
}

async function withTelemetryStateLock(
  stateFile: string,
  run: () => Promise<string>,
): Promise<string | undefined> {
  const lockFile = join(dirname(stateFile), "telemetry-state.lock");
  await mkdir(dirname(stateFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      lockHandle = await open(lockFile, "wx");
      await lockHandle.writeFile(
        JSON.stringify({ createdAt: Date.now(), pid: process.pid }),
        "utf8",
      );
      return await run();
    } catch (error) {
      if (!isFileExistsError(error) || !(await removeStaleTelemetryStateLock(lockFile))) {
        throw error;
      }
    } finally {
      if (lockHandle !== undefined) {
        await lockHandle.close();
        try {
          await unlink(lockFile);
        } catch {
          // 另一个进程可能已回收异常残留；锁清理失败不影响模型链路。
        }
      }
    }
  }
  // 另一个活跃进程正在更新同一文件时不等待；本次仅缺少匿名 device 关联。
  return await readDeviceMid(stateFile);
}

async function removeStaleTelemetryStateLock(lockFile: string): Promise<boolean> {
  try {
    const metadata = await stat(lockFile);
    if (Date.now() - metadata.mtimeMs < TELEMETRY_STATE_LOCK_STALE_MS) {
      const owner = await readTelemetryState(lockFile);
      const pid =
        typeof owner.pid === "number" && Number.isInteger(owner.pid) ? owner.pid : undefined;
      if (!pid || isProcessAlive(pid)) return false;
    }
    await unlink(lockFile);
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}

function isFileExistsError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

async function readTelemetryState(stateFile: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function readDeviceMid(stateFile: string): Promise<string | undefined> {
  return deviceMidFromState(await readTelemetryState(stateFile));
}

function deviceMidFromState(state: Record<string, unknown>): string | undefined {
  return typeof state.deviceMid === "string" && state.deviceMid.trim()
    ? state.deviceMid.trim()
    : undefined;
}
