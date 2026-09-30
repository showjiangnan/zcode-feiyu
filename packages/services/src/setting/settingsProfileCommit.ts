// Modified by ZCode Feiyu contributors (2026).
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
const COMMIT_WAIT_MS = 30_000;
const LOCK_RETRY_MS = 20;

/** profile 级提交互斥；SQL 只仲裁，setting.json 仍是唯一设置正文。 */
export async function withSettingsProfileCommit<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, "settings-commit.sqlite"));
  let locked = false;
  try {
    db.exec("pragma busy_timeout = 0");
    const deadline = Date.now() + COMMIT_WAIT_MS;
    while (!locked) {
      try {
        // 原因：进程内 Promise 队列不能保护多个窗口的 read/merge/write；
        // 持有数据库写事务直到文件提交完成，进程退出自动释放且不可被超时抢占。
        db.exec("begin exclusive");
        locked = true;
      } catch (error) {
        const code =
          error && typeof error === "object" && "errcode" in error ? error.errcode : undefined;
        if ((code !== 5 && code !== 6) || Date.now() >= deadline) throw error;
        await delay(LOCK_RETRY_MS);
      }
    }
    const result = await operation();
    db.exec("commit");
    locked = false;
    return result;
  } finally {
    if (locked) db.exec("rollback");
    db.close();
  }
}
