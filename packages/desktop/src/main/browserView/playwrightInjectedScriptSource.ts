import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";

const runtimeRequire = createRequire(import.meta.url);
const GENERATED_SOURCE_ASSIGNMENT = /const source\s*=\s*/;

let cachedSource: string | undefined;

function readStringLiteralEnd(source: string, start: number): number {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") {
    throw new Error("Playwright injected source assignment is not a string literal");
  }
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === quote) return index + 1;
  }
  throw new Error("Playwright injected source string literal is unterminated");
}

/**
 * Playwright 1.59 的 generated injected script 未作为 public export 暴露。
 * DOM snapshot 使用 Apache-2.0 许可的 Playwright runtime；这里从固定版本依赖中只读取对应
 * 字符串字面量并缓存，避免复制一份数十万字符的生成代码，也避免退回手写 ARIA 猜测。
 */
export function getPlaywrightInjectedScriptSource(): string {
  if (cachedSource) return cachedSource;

  const packageJsonPath = runtimeRequire.resolve("playwright-core/package.json");
  const generatedSourcePath = join(
    dirname(packageJsonPath),
    "lib",
    "generated",
    "injectedScriptSource.js",
  );
  const generatedModule = readFileSync(generatedSourcePath, "utf8");
  const assignment = GENERATED_SOURCE_ASSIGNMENT.exec(generatedModule);
  if (!assignment) {
    throw new Error("Unable to locate Playwright injected source assignment");
  }
  const literalStart = assignment.index + assignment[0].length;
  const literalEnd = readStringLiteralEnd(generatedModule, literalStart);
  const literal = generatedModule.slice(literalStart, literalEnd);
  // 这里只解析固定依赖中的单个字符串字面量；不执行 generated module，也不接触网页内容。
  const decoded: unknown = runInNewContext(literal, Object.create(null), { timeout: 1_000 });
  if (
    typeof decoded !== "string" ||
    !decoded.includes("module.exports = __toCommonJS(injectedScript_exports)") ||
    !decoded.includes("incrementalAriaSnapshot")
  ) {
    throw new Error("Playwright injected source failed integrity checks");
  }
  cachedSource = decoded;
  return decoded;
}
