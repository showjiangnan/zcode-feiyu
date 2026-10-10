// Modified by ZCode Feiyu contributors (2026).
// 旧默认值与模型常用的 30 秒页面等待相同，发送等副作用成功后会在结果读取前被中止。
// 执行层和模型可见文案共用该常量，避免真实超时与 tools/list 描述漂移。
export const NODE_REPL_DEFAULT_TIMEOUT_MS = 60_000;

// MCP serverInfo 曾长期硬编码为 0.1.0，与插件发布版本分叉，导致宿主无法据此判断
// 实际加载的 Browser Use runtime。版本升级时该值应与 package.json 同步。
// 宿主自己的版本，不是 browser-use 插件的版本。把宿主抽成 @zcode/node-repl-host
// 时保留了这个数字：它一直就是 node_repl server 对外宣告的版本，换个数字等于无谓地改协议。
// 从此它随宿主契约（bridge 成员、工具面）变化，与两个插件各自的版本解耦。
// 升到 0.5.0：本次宿主契约本身变了（node_repl 从 browser-use 抽出成独立 seed 单元、
// 工具面随 CUA 的 node_repl SDK 重建调整），按上面这条规则该动。数字与 browser-use 0.5.0 相同
// 只是同源历史的巧合，不构成耦合——两者仍各自独立升版。
// 升到 0.6.0：工具面收敛到只剩 `js`，`js_reset` 与 `js_add_node_module_dir` 连同
// moduleDirs 能力一起删除。前者自 fresh-kernel 改造起就是固定返回成功的空操作，且"永不失败"
// 会让模型连续重复调用（重复调用会持续消耗预算）；后者
// 是把宿主职责推给模型——模型无法自行知道该传哪个 node_modules，能告诉它的只有 skill 文档，
// 而文档知道的路径宿主自己就能注入。两者实测调用量均为 0。宿主协议变了就得让 serverInfo 能被
// 据此识别，否则宿主无法区分自己连上的是哪一代工具面。
// 本轮修复真实凭据绑定及结构化诊断，serverInfo 与新的宿主 seed 同步，避免旧缓存冒充修复版。
export const NODE_REPL_SERVER_VERSION = "0.7.13";
export const NODE_REPL_SERVER_INSTRUCTIONS =
  "Browser Use and Computer Use only. Run JavaScript with top-level await in a persistent, task-scoped Node kernel. Follow the active official capability skill. Always provide title in the user's language. Global bindings persist within this task; use var for reusable bindings. Cancellation, crash or idle eviction resets the kernel and expires its old bindings. Never use this host for unrelated shell, filesystem or data processing tasks.";
export const JS_TOOL_DESCRIPTION =
  NODE_REPL_SERVER_INSTRUCTIONS +
  " Calls default to 60000ms; set timeout_ms (up to 120000) for longer operations. Computer Control uses the persistent global cua SDK: await cua.initialize(), cua.listApps(), cua.getApp(appId), app.listWindows(), app.getWindow(windowId), window.getState(), then observation-bound actions. Enabling Computer Control approves all local apps for qualified workspace tasks; do not ask for per-app or per-turn approval. Actual operating-system permissions are still required. State has nodes and channels, not a text property. The trusted bridge automatically emits native image/state results; do not print full result objects or copy/re-encode images. Use nodeRepl.write for short text. Read fresh state after every stale target, reset, focus change or explicit continuation. Coordinates refer to the current image pixels; never infer them from screen bounds. Subagents cannot use Computer Control. Browser wrappers may also persist, while their BrowserControl generation and active tab must remain current.";
