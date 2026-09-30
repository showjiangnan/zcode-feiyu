// Modified by ZCode Feiyu contributors (2026).
import { homedir } from "node:os";
import { join } from "node:path";

function resolveUserHomeDir() {
  // 独立桌面 Dev 实例已设置自己的 home，设置服务却仍写真实 HOME，
  // 导致启动迁移和外观操作污染其他实例。与 Electron 的显式 home 覆盖保持一致。
  const envHome =
    process.env.ZCODE_DESKTOP_HOME_DIR?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

export function getSettingsDir() {
  return join(resolveUserHomeDir(), ".zcode", "v2");
}

export function getSettingsFile() {
  return join(getSettingsDir(), "setting.json");
}
