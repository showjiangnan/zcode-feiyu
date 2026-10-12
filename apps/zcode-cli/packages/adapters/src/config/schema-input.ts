// Modified by ZCode Feiyu.
export function normalizeMcpServerConfigInput(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const server = { ...(value as Record<string, unknown>) };
  if (!("env" in server) && "environment" in server) {
    // 旧配置和部分外部导入使用 environment；运行态只消费 env。
    // 在解析入口归一化，避免一个 legacy MCP server 拖垮整份 config。
    server.env = server.environment;
  }
  delete server.environment;

  if (typeof server.enable === "boolean" || typeof server.enabled === "boolean") {
    // 历史遗留兜底：桌面端早期把停用状态写成 enable，而契约字段一直是 enabled。
    // 桌面端与 mcp-sync 现在只写 enabled，并在加载配置时把存量 enable 就地迁移落盘；
    // CLI 是只读解析、不能写盘，这里只覆盖「用户先跑 CLI、还没开过桌面端」的窗口。
    // 冲突时以「停用」为准：桌面端写 enable:false 时不会清理外部导入残留的 enabled:true，
    // 按 enabled 取值会把用户关掉的 server 重新拉起（停用了还在被调用）。
    // 存量配置迁移完毕后，这段连同下面的 delete 可以整块删除。
    server.enabled = server.enable === false ? false : (server.enabled ?? true);
  }
  delete server.enable;

  // External MCP configs may carry provider-specific timeout fields. ZCode does not migrate
  // those values, but the strict runtime schema should still accept old imported entries.
  delete server.timeout;
  delete server.startup_timeout_sec;

  if (server.type === "remote") {
    // 外部 Agent 配置常把 HTTP MCP 标记为 remote；ZCode 运行态协议类型是 http。
    server.type = "http";
  } else if (typeof server.type !== "string") {
    // app 管理层把 command 形态视为默认 stdio；CLI 也需要同样推断，
    // 否则历史 app 配置缺少 type 时会阻断模型配置加载。
    if (typeof server.command === "string" && server.command.trim().length > 0) {
      server.type = "stdio";
    } else if (typeof server.url === "string" && server.url.trim().length > 0) {
      server.type = "http";
    }
  }

  if (
    (server.type === "http" || server.type === "sse") &&
    server.headers === undefined &&
    server.http_headers !== undefined
  ) {
    // 兼容历史 BigModel MCP 配置：旧字段名是 http_headers，agent runtime 只消费 headers。
    server.headers = server.http_headers;
  }
  delete server.http_headers;

  return server;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
