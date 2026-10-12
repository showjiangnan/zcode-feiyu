// Modified by ZCode Feiyu.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * 判定当前安装的 `@zcode/zcode-cua` 是否提供真实原生 producer。
 *
 * 飞鱼版在根 workspace 提供原生 producer；部分上游布局以占位包替代它。
 * 占位包在 package.json 声明 `zcodeCuaPlaceholder: true`，所有能力 fail-closed。
 * 开发、构建与打包里只服务于真实 Computer Use 的步骤（构建 Helper、暂存插件原生依赖、
 * Windows Helper 资源、打包后的 Helper 校验）都以本判定为门，检测不到真实 producer 时跳过，
 * 不能把占位包误当作飞鱼版原生实现。保留规则见 spec/upstream-integration/README.md。
 *
 * 构建配置（electron-builder、tsup）同步求值，这里只做一次小文件同步读取。
 */
export function readComputerUseProducer({ desktopPackageRoot }) {
  // 从桌面包向上查找最近的安装，兼容根 workspace 与包内链接。
  for (let dir = resolve(desktopPackageRoot); ; dir = dirname(dir)) {
    const manifestPath = resolve(dir, "node_modules", "@zcode", "zcode-cua", "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      return {
        installed: true,
        placeholder: manifest.zcodeCuaPlaceholder === true,
        manifest,
        packageRoot: dirname(manifestPath),
      };
    }
    if (dirname(dir) === dir) return { installed: false, placeholder: false };
  }
}

export function isRealComputerUseProducerInstalled({ desktopPackageRoot }) {
  const producer = readComputerUseProducer({ desktopPackageRoot });
  return producer.installed && !producer.placeholder;
}
