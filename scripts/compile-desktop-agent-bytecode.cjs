"use strict";

const { readFile, writeFile } = require("node:fs/promises");
const Module = require("node:module");
const vm = require("node:vm");
const {
  configureBytecodeRuntime,
  bytecodeDigest,
} = require("./desktop-agent-bytecode-runtime.cjs");

async function compile() {
  const [entryPath, outputPath] = process.argv.slice(2);
  const runtime = configureBytecodeRuntime();
  if (!runtime.electron) throw new Error("桌面 Agent 字节码必须由 Electron Node 模式编译");
  const source = await readFile(entryPath, "utf8");
  const wrapped = Module.wrap(source.replace(/^#![^\r\n]*/, ""));
  const script = new vm.Script(wrapped, {
    filename: entryPath,
    importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  // 仅编译，不调用模块；不能为了预热缓存触发 CLI 的存储、网络或进程副作用。
  const cachedData = script.createCachedData();
  await writeFile(outputPath, cachedData);
  process.stdout.write(
    JSON.stringify({
      runtime,
      sourceLength: wrapped.length,
      sourceSha256: bytecodeDigest(Buffer.from(source)),
      bytecodeSha256: bytecodeDigest(cachedData),
      bytecodeBytes: cachedData.length,
    }),
  );
}

compile().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
