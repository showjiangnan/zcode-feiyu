import { access } from "node:fs/promises";

function normalizeWindowsCommandFragment(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

export async function isDelegatedWindowsExplorerExit(
  error: unknown,
  appPath: string,
  args: string[],
  candidate: string,
): Promise<boolean> {
  if (process.platform !== "win32" || typeof error !== "object" || error === null) {
    return false;
  }

  const execError = error as {
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
    cmd?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  if (
    execError.code !== 1 ||
    execError.killed !== false ||
    execError.signal !== null ||
    typeof execError.cmd !== "string" ||
    typeof execError.message !== "string" ||
    !execError.message.startsWith("Command failed:") ||
    (typeof execError.stderr === "string" && execError.stderr.trim())
  ) {
    return false;
  }

  const normalizedCommand = normalizeWindowsCommandFragment(execError.cmd);
  const matchesInvokedCommand = [appPath, ...args].every((fragment) =>
    normalizedCommand.includes(normalizeWindowsCommandFragment(fragment)),
  );
  if (!matchesInvokedCommand) {
    return false;
  }

  try {
    // Explorer 的 code=1 同时可能表示“已委托”或“目标不可访问”。只有 UNC 目标
    // 在同一时刻确实可访问，才允许把已知委托退出形态视为成功。
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}
