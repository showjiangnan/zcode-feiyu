import { resolveTerminalEnv } from "./terminalEnvironment.js";
import { accessSync, chmodSync, constants, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, release } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { Emitter, type Event } from "@zcode/rpc";
import type { IPty } from "node-pty";
import type { ISettingService } from "../setting/setting.js";
import type {
  ITerminalService,
  TerminalWindowsPtyInfo,
  TerminalProfile,
  TerminalChunk,
} from "./terminal.js";
import {
  resolveTerminalFontProfile,
  type TerminalFontFamilySource,
  type TerminalThemeProfile,
} from "./terminalProfile.js";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

const require = createRequire(import.meta.url);
type NodePtyModule = typeof import("node-pty");
type PtySpawnOptions = Parameters<NodePtyModule["spawn"]>[2];

interface TerminalInstance {
  profile: TerminalProfile;
  chunks: TerminalChunk[];
  sequence: number;
  bytes: number;
  replayEmitter: Emitter<TerminalChunk>;
  pty: IPty;
  dataEmitter: Emitter<string>;
  exitEmitter: Emitter<number>;
}

let hasEnsuredNodePtyHelper = false;
let nodePtyModulePromise: Promise<NodePtyModule> | null = null;

async function loadNodePtyModule(): Promise<NodePtyModule> {
  if (!nodePtyModulePromise) {
    nodePtyModulePromise = import("node-pty").catch((error: unknown) => {
      nodePtyModulePromise = null;
      const message = error instanceof Error ? error.message : String(error);
      // remote server 启动时会先创建所有服务，之前这里顶层 import node-pty，
      // 只要当前平台缺少 pty.node，就会在服务注册阶段直接崩掉，整条远程连接链路都失败。
      // 改成延迟加载后，server 可以先完成握手，仅在真正创建终端时再暴露“terminal 不可用”的错误。
      throw new Error(`node-pty is unavailable in this runtime: ${message}`);
    }) as Promise<NodePtyModule>;
  }

  return nodePtyModulePromise;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseWindowsBuildNumber(releaseText: string): number | undefined {
  const buildText = releaseText.split(".")[2];
  if (!buildText) return undefined;
  const buildNumber = Number.parseInt(buildText, 10);
  return Number.isFinite(buildNumber) ? buildNumber : undefined;
}

function resolveTerminalWindowsPtyInfo(
  platform: NodeJS.Platform = process.platform,
  releaseText: string = release(),
): TerminalWindowsPtyInfo | undefined {
  if (platform !== "win32") return undefined;

  return {
    backend: "conpty",
    buildNumber: parseWindowsBuildNumber(releaseText),
  };
}

function isExecutable(command: string): boolean {
  try {
    if (/[\\/]/.test(command)) {
      accessSync(command, constants.X_OK);
      return true;
    }

    const pathEnv = process.env.PATH;
    if (!pathEnv) return false;

    return pathEnv.split(delimiter).some((dir) => {
      if (!dir) return false;
      try {
        accessSync(join(dir, command), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function isUsableDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function resolveNodePtySpawnHelperPath(): string | null {
  if (process.platform !== "darwin") return null;

  try {
    const utils = require("node-pty/lib/utils") as {
      loadNativeModule(name: string): { dir: string };
    };
    const native = utils.loadNativeModule("pty");
    const unixTerminalPath = require.resolve("node-pty/lib/unixTerminal.js");

    let helperPath = resolve(dirname(unixTerminalPath), `${native.dir}/spawn-helper`);
    helperPath = helperPath.replace("app.asar", "app.asar.unpacked");
    helperPath = helperPath.replace("node_modules.asar", "node_modules.asar.unpacked");
    return helperPath;
  } catch {
    return null;
  }
}

function ensureNodePtySpawnHelperExecutable(): void {
  if (hasEnsuredNodePtyHelper || process.platform !== "darwin") return;
  hasEnsuredNodePtyHelper = true;

  const helperPath = resolveNodePtySpawnHelperPath();
  if (!helperPath || !existsSync(helperPath)) return;

  try {
    accessSync(helperPath, constants.X_OK);
    return;
  } catch {
    // 当前环境里的 node-pty spawn-helper 丢了执行权限，
    // child_process.spawn 还能工作，但 node-pty 在 macOS 上启动伪终端时会先调用这个 helper，
    // helper 不可执行就会直接报 posix_spawnp failed。
    // 这里在真正 spawn 前把 helper 修正为 0755，避免终端因为安装产物权限漂移而无法打开。
  }

  try {
    chmodSync(helperPath, 0o755);
    accessSync(helperPath, constants.X_OK);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`node-pty spawn-helper is not executable: ${helperPath}. ${message}`);
  }
}

function shouldFallbackFromConptyDll(error: unknown): boolean {
  const message = getErrorMessage(error);
  return /conpty\.node module handle|conpty\.node module file name|cannot find conpty\.dll|error code:\s*126/i.test(
    message,
  );
}

function spawnTerminalProcess(params: {
  nodePty: NodePtyModule;
  shell: string;
  cols: number;
  rows: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): IPty {
  const { nodePty, shell, cols, rows, cwd, env } = params;

  if (process.platform !== "win32") {
    return nodePty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env,
      encoding: "utf8",
    });
  }

  const windowsBaseOptions = {
    useConpty: true,
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env,
    encoding: "utf8",
  } satisfies PtySpawnOptions;

  try {
    return nodePty.spawn(shell, [], {
      ...windowsBaseOptions,
      useConptyDll: true,
    });
  } catch (error) {
    if (!shouldFallbackFromConptyDll(error)) {
      throw error;
    }

    // Windows 下开启 node-pty 的实验性 useConptyDll 时，某些 Electron/安装包环境会在 shell 真正启动前
    // 就因为 conpty.node / conpty.dll 的原生模块定位失败直接报错，导致终端整个打不开。
    // 这里仅在命中这类 DLL 加载错误时回退到系统内置 ConPTY，既保留新版路径的优先级，也避免把普通启动失败误判成可重试。
    return nodePty.spawn(shell, [], {
      ...windowsBaseOptions,
      useConptyDll: false,
    });
  }
}

function resolveTerminalShell(): string {
  if (process.platform === "win32") {
    // Windows PowerShell 5.1 的 PSReadLine 在 ConPTY 下更容易把输入行空白重绘成 ANSI black 背景。
    // PowerShell 7+ 的终端兼容性更接近桌面端，优先使用已安装的 pwsh，找不到再回退到系统自带 shell。
    const candidates = ["pwsh.exe", "powershell.exe", process.env.ComSpec, "cmd.exe"];

    for (const candidate of candidates) {
      if (candidate && isExecutable(candidate)) return candidate;
    }

    throw new Error("No usable Windows shell found for terminal startup");
  }

  // 之前直接信任 SHELL 环境变量，外部环境如果残留了一个不存在的 shell 路径，
  // node-pty 底层会把这个坏路径直接交给 posix_spawnp，终端创建时就会报错。
  // 这里先校验 SHELL 是否真的可执行，不可用时再按常见 shell 顺序回退，避免启动直接失败。
  const candidates = [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"];

  for (const candidate of candidates) {
    if (candidate && isExecutable(candidate)) return candidate;
  }

  throw new Error("No usable shell found for terminal startup");
}

function resolveTerminalCwd(cwd?: string): string {
  // 工作区目录可能已经被删除、移动，或者启动时传进来的是一个失效路径。
  // 之前把这个 cwd 原样传给 node-pty，同样会在 spawn 阶段失败。
  // 这里优先使用传入目录，不可用时回退到 HOME / 系统 home / 根目录，保证终端还能拉起。
  const candidates = [cwd, process.env.HOME, homedir(), "/"];

  for (const candidate of candidates) {
    if (candidate && isUsableDirectory(candidate)) return candidate;
  }

  throw new Error("No usable working directory found for terminal startup");
}

export function createTerminalService(dependencies: {
  settingService: ISettingService;
}): ITerminalService {
  const terminals = new Map<string, TerminalInstance>();
  let nextId = 0;
  // 内存诊断计数器：客户端断连不回收 pty 时
  // 这里会只增不减。
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("terminal", () => ({
    open: terminals.size,
  }));

  function getTerminal(id: string): TerminalInstance {
    const t = terminals.get(id);
    if (!t) throw new Error(`Terminal not found: ${id}`);
    return t;
  }

  function cleanupTerminal(id: string): void {
    const terminal = terminals.get(id);
    if (!terminal) {
      return;
    }

    terminal.pty.kill();
    terminal.replayEmitter.dispose();
    terminal.dataEmitter.dispose();
    terminal.exitEmitter.dispose();
    terminals.delete(id);
  }

  const service: ITerminalService & { disposeAll(): void } = {
    async create(params: { cols: number; rows: number; cwd?: string }): Promise<{
      id: string;
      shell: string;
      fontFamily: string;
      fontSize?: number;
      theme?: TerminalThemeProfile;
      fontFamilySource: TerminalFontFamilySource;
      windowsPty?: TerminalWindowsPtyInfo;
    }> {
      const id = String(nextId++);
      const shell = resolveTerminalShell();
      const cwd = resolveTerminalCwd(params.cwd);
      const env = resolveTerminalEnv();
      const terminalProfileSettings = await dependencies.settingService.get().catch(() => ({
        terminalFontFamily: undefined,
        terminalInheritSystemProfile: true,
      }));
      const fontProfile = resolveTerminalFontProfile({
        settings: terminalProfileSettings,
        env: process.env,
      });
      const nodePty = await loadNodePtyModule();
      ensureNodePtySpawnHelperExecutable();
      const dataEmitter = new Emitter<string>();
      const exitEmitter = new Emitter<number>();

      let p: IPty;
      try {
        p = spawnTerminalProcess({
          nodePty,
          shell,
          cols: params.cols,
          rows: params.rows,
          cwd,
          env,
        });
      } catch (error) {
        throw new Error(
          `Failed to start terminal with shell '${shell}' in '${cwd}': ${getErrorMessage(error)}`,
        );
      }

      const replayEmitter = new Emitter<TerminalChunk>();
      const profile: TerminalProfile = {
        id,
        cwd,
        shell,
        fontFamily: fontProfile.fontFamily,
        fontSize: fontProfile.fontSize,
        theme: fontProfile.theme,
        fontFamilySource: fontProfile.source,
        windowsPty: resolveTerminalWindowsPtyInfo(),
      };
      const instance: TerminalInstance = {
        pty: p,
        dataEmitter,
        exitEmitter,
        replayEmitter,
        profile,
        chunks: [],
        sequence: 0,
        bytes: 0,
      };
      p.onData((data) => {
        const bytes = Buffer.from(data);
        const replayData =
          bytes.length > 1024 * 1024
            ? bytes.subarray(bytes.length - 1024 * 1024).toString("utf8")
            : data;
        const chunk = { sequence: ++instance.sequence, data: replayData };
        instance.chunks.push(chunk);
        instance.bytes += Buffer.byteLength(replayData);
        // 回放只保留有界尾部；Host 不为掉线客户端无限保存 shell 输出。
        while (instance.bytes > 1024 * 1024 && instance.chunks.length > 1)
          instance.bytes -= Buffer.byteLength(instance.chunks.shift()!.data);
        replayEmitter.fire(chunk);
        dataEmitter.fire(data);
      });
      p.onExit(({ exitCode }) => {
        exitEmitter.fire(exitCode);
        replayEmitter.dispose();
        dataEmitter.dispose();
        exitEmitter.dispose();
        terminals.delete(id);
      });

      terminals.set(id, instance);
      return {
        id,
        shell,
        fontFamily: fontProfile.fontFamily,
        fontSize: fontProfile.fontSize,
        theme: fontProfile.theme,
        fontFamilySource: fontProfile.source,
        windowsPty: resolveTerminalWindowsPtyInfo(),
      };
    },

    async list() {
      return [...terminals.values()].map((item) => item.profile);
    },
    async attach({ id, afterSequence = 0 }) {
      const item = getTerminal(id);
      if (
        !Number.isSafeInteger(afterSequence) ||
        afterSequence < 0 ||
        afterSequence > item.sequence
      )
        throw new Error("TERMINAL_CURSOR_INVALID");
      return {
        ...item.profile,
        chunks: item.chunks.filter((chunk) => chunk.sequence > afterSequence),
        sequence: item.sequence,
        truncated: afterSequence < (item.chunks[0]?.sequence ?? 1) - 1,
      };
    },
    async detach({ id }) {
      getTerminal(id);
    },
    onDynamicReplayData(id) {
      return getTerminal(id).replayEmitter.event;
    },
    async write(params: { id: string; data: string }): Promise<void> {
      getTerminal(params.id).pty.write(params.data);
    },

    async resize(params: { id: string; cols: number; rows: number }): Promise<void> {
      getTerminal(params.id).pty.resize(params.cols, params.rows);
    },

    async dispose(params: { id: string }): Promise<void> {
      cleanupTerminal(params.id);
    },

    onDynamicData(id: string): Event<string> {
      return getTerminal(id).dataEmitter.event;
    },

    onDynamicExit(id: string): Event<number> {
      return getTerminal(id).exitEmitter.event;
    },

    disposeAll(): void {
      memoryDiagnostics.dispose();
      // app 关闭时 host process 以前只会结束自身，terminal 里的子 shell 没有逐个显式 kill。
      // 这里补一个本地清理入口，让 host 在退出链路里能同步回收所有仍存活的终端进程。
      for (const id of Array.from(terminals.keys())) {
        cleanupTerminal(id);
      }
    },
  };

  return service;
}
