"use strict";

const v8 = require("node:v8");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { basename, dirname, join } = require("node:path");

function configureBytecodeRuntime() {
  // 字节码不带可重新编译的源码，必须完整编译并保留字节码；编译器和加载器共用这一处配置。
  v8.setFlagsFromString("--no-lazy --no-flush-bytecode");
  return {
    electron: process.versions.electron ?? null,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    cachedDataVersionTag: v8.cachedDataVersionTag(),
  };
}

function bytecodeDigest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function loadBytecode(metadata, targetModule, targetRequire) {
  const runtime = configureBytecodeRuntime();
  if (JSON.stringify(runtime) !== JSON.stringify(metadata.runtime)) {
    throw new Error(
      "字节码运行时不匹配，请用当前 Electron 重新运行 pnpm build:desktop-agent:bytecode",
    );
  }
  const directory = dirname(targetModule.filename);
  if (basename(metadata.bytecodeFile) !== metadata.bytecodeFile) {
    throw new Error("无效的字节码文件名");
  }
  const cachedData = await readFile(join(directory, metadata.bytecodeFile));
  if (bytecodeDigest(cachedData) !== metadata.bytecodeSha256) {
    throw new Error("字节码摘要不匹配，请重新构建桌面 Agent");
  }
  // 使用 ASCII 空格而非双字节零宽字符。这里只消除明文源码，仍保留等长占位内存。
  const source = " ".repeat(metadata.sourceLength);
  const filename = join(directory, metadata.sourceFile);
  const script = new vm.Script(source, {
    cachedData,
    filename,
    // 动态 import 必须交回 Node，继续按原 bundle 的 URL 解析外置 ESM 与原生依赖。
    importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  if (script.cachedDataRejected) {
    throw new Error("V8 拒绝字节码缓存，请重新构建桌面 Agent");
  }
  const run = script.runInThisContext();
  if (typeof run !== "function") throw new Error("字节码不是 CommonJS 模块");
  run.call(
    targetModule.exports,
    targetModule.exports,
    targetRequire,
    targetModule,
    filename,
    directory,
  );
}

module.exports = { configureBytecodeRuntime, bytecodeDigest, loadBytecode };
