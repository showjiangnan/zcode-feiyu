// Modified by ZCode Feiyu.
import { z } from "zod";
import { normalizeMcpServerConfigInput } from "./schema-input.js";

export const stringRecordSchema = z.record(z.string(), z.string());

export const positiveNumberSchema = z.number().finite().positive();

export const positiveIntegerSchema = z.number().int().positive();

export const modelStreamSchema = z.object({
  idleTimeoutMs: positiveNumberSchema.optional(),
});

export const permissionSchema = z.object({
  mode: z.enum(["plan", "build", "edit", "yolo", "guarded", "auto"]).optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  autoApproveHighRisk: z.boolean().optional(),
  allowMediumRiskInAuto: z.boolean().optional(),
});

export const storageSchema = z.object({
  dir: z.string().min(1).optional(),
  sessionDbPath: z.string().min(1).optional(),
});

export const networkSchema = z.object({
  httpProxy: z.string().min(1).optional(),
  noProxy: z.string().min(1).optional(),
  caCertFile: z.string().min(1).optional(),
  timeout: positiveNumberSchema.optional(),
});

export const featuresSchema = z.object({
  compact: z.boolean().optional(),
  rewind: z.boolean().optional(),
  subagent: z.boolean().optional(),
  memory: z.boolean().optional(),
  skill: z.boolean().optional(),
  mcp: z.boolean().optional(),
});

export const memorySchema = z.object({
  use: z.boolean().optional(),
});

export const mcpServerBaseSchema = {
  // 设置页和 MCP adapter 已支持协议选择；配置入口漏掉该字段会因 strict 校验丢弃整个 server。
  protocolVersion: z.enum(["auto", "legacy", "2026-07-28"]).optional(),
  enabled: z.boolean().optional(),
  timeoutMs: positiveNumberSchema.optional(),
};

export const mcpOAuthSchema = z.union([
  z
    .object({
      type: z.literal("client_credentials"),
      clientId: z.string().min(1),
      clientSecret: z.string().min(1),
      clientName: z.string().min(1).optional(),
      scope: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("authorization_code"),
      clientId: z.string().min(1).optional(),
      clientSecret: z.string().min(1).optional(),
      clientName: z.string().min(1).optional(),
      redirectPath: z.string().min(1).optional(),
      scope: z.string().optional(),
    })
    .strict(),
]);

export const mcpStdioServerSchema = z
  .object({
    ...mcpServerBaseSchema,
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().min(1).optional(),
    env: stringRecordSchema.optional(),
  })
  .strict();

export const mcpHttpServerSchema = z
  .object({
    ...mcpServerBaseSchema,
    type: z.literal("http"),
    url: z.string().min(1),
    headers: stringRecordSchema.optional(),
    oauth: mcpOAuthSchema.optional(),
  })
  .strict();

export const mcpSseServerSchema = z
  .object({
    ...mcpServerBaseSchema,
    type: z.literal("sse"),
    url: z.string().min(1),
    headers: stringRecordSchema.optional(),
    oauth: mcpOAuthSchema.optional(),
  })
  .strict();

export const mcpServerSchema = z.preprocess(
  normalizeMcpServerConfigInput,
  z.discriminatedUnion("type", [mcpStdioServerSchema, mcpHttpServerSchema, mcpSseServerSchema]),
);

export const mcpSchema = z.object({
  servers: z.record(z.string(), mcpServerSchema).optional(),
});

export const pluginOptionValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const pluginMarketplaceSourceSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("url"),
      url: z.string().min(1),
      headers: stringRecordSchema.optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal("github"),
      repo: z.string().min(1),
      ref: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
      sparsePaths: z.array(z.string().min(1)).optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal("git"),
      url: z.string().min(1),
      ref: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
      sparsePaths: z.array(z.string().min(1)).optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal("npm"),
      package: z.string().min(1),
    })
    .strict(),
  z
    .object({
      source: z.literal("file"),
      path: z.string().min(1),
    })
    .strict(),
  z
    .object({
      source: z.literal("directory"),
      path: z.string().min(1),
    })
    .strict(),
]);

export const pluginsSchema = z.object({
  enabled: z.boolean().optional(),
  dirs: z.array(z.string().min(1)).optional(),
  enabledPlugins: z.record(z.string(), z.boolean()).optional(),
  extraKnownMarketplaces: z
    .record(z.string().min(1), z.object({ source: pluginMarketplaceSourceSchema }).strict())
    .optional(),
  options: z.record(z.string(), z.record(z.string(), pluginOptionValueSchema)).optional(),
  suppressedBuiltins: z.array(z.string().min(1)).optional(),
});

export const LEGACY_CUA_PLUGIN_ID = "zcode-cua@zcode-plugins-official";

export const CANONICAL_CUA_PLUGIN_ID = "computer-use@zcode-plugins-official";

export function canonicalizePluginId(pluginId: string): string {
  return pluginId === LEGACY_CUA_PLUGIN_ID ? CANONICAL_CUA_PLUGIN_ID : pluginId;
}

export function pluginIdAliases(pluginId: string): readonly string[] {
  return canonicalizePluginId(pluginId) === CANONICAL_CUA_PLUGIN_ID
    ? [CANONICAL_CUA_PLUGIN_ID, LEGACY_CUA_PLUGIN_ID]
    : [pluginId];
}

export const skillToggleSchema = z.object({
  enable: z.boolean().optional(),
});

export // skill / command 可用性覆盖：key 为对应 .md 的绝对路径，enable:false 表示禁用
const skillCommandOverrideSchema = z
  .object({
    enable: z.boolean().optional(),
  })
  .passthrough();

export const skillCommandOverridesSchema = z.record(z.string(), skillCommandOverrideSchema);

export const skillsSchema = z
  .object({
    enabled: z.boolean().optional(),
    includeInstructions: z.boolean().optional(),
    metadataBudget: positiveNumberSchema.optional(),
    roots: z.array(z.string()).optional(),
  })
  .catchall(skillToggleSchema);

export const loggingSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  format: z.enum(["text", "json"]).optional(),
});

export const uiSchema = z.object({
  locale: z.enum(["auto", "en-US", "zh-CN"]).optional(),
  theme: z.enum(["auto", "dark", "light"]).optional(),
});

export const toolConcurrencySchema = z.object({
  maxConcurrency: positiveNumberSchema.optional(),
});

export const modelAnomalyGuardSchema = z.object({
  toolCallWarningThreshold: positiveIntegerSchema.optional(),
  repeatedToolCallWarningThreshold: positiveIntegerSchema.optional(),
  maxBudgetWarningsPerTurn: z.number().int().nonnegative().optional(),
});

// Hooks schema：
// 理想态是 re-export shared/workspace-hook-config，但两个 pnpm workspace 解析出物理
// 不同的 zod 实例（adapters 4.4.3 / shared 4.3.6）：shared schema 嵌入本包组合 schema
// 会让 dts 引用 foreign zod 内部类型（TS2742），typeof/ZodType 注解都会落入类型循环。
// 因此本副本按原样保留（本包 zod 构造），并保持与 shared 的校验语义等价；
// 运行时校验语义仍以 shared 为准（discovery/trust 装配入口都走 shared schema——
// 本 schema 只负责配置文件装载诊断）。若未来统一 zod 实例，应删除本副本改 re-export。
export const hookProcessSchema = z
  .object({
    type: z.literal("process"),
    command: z.string().min(1),
    enabled: z.boolean().optional(),
    args: z.array(z.string()).optional(),
    timeoutMs: positiveNumberSchema.optional(),
    statusMessage: z.string().min(1).optional(),
  })

  .passthrough();

export const hookCommandSchema = z
  .object({
    type: z.literal("command"),
    command: z.string().min(1),
    enabled: z.boolean().optional(),
    async: z.boolean().optional(),
    shell: z.union([z.literal(true), z.string().min(1)]).optional(),
    timeout: positiveNumberSchema.optional(),
    timeoutMs: positiveNumberSchema.optional(),
    statusMessage: z.string().min(1).optional(),
  })
  .passthrough();

export const hookMatcherSchema = z
  .object({
    matcher: z.string().min(1).optional(),
    hooks: z.array(z.discriminatedUnion("type", [hookProcessSchema, hookCommandSchema])).min(1),
  })
  .strict();

export const hooksSchema = z
  .object({
    enabled: z.boolean().optional(),
    timeoutMs: positiveNumberSchema.optional(),
    maxOutputBytes: positiveNumberSchema.optional(),
    events: z
      .object({
        SessionStart: z.array(hookMatcherSchema).optional(),
        UserPromptSubmit: z.array(hookMatcherSchema).optional(),
        PreToolUse: z.array(hookMatcherSchema).optional(),
        PermissionRequest: z.array(hookMatcherSchema).optional(),
        PostToolUse: z.array(hookMatcherSchema).optional(),
        PostToolUseFailure: z.array(hookMatcherSchema).optional(),
        Stop: z.array(hookMatcherSchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ZCodeConfigFileSchema = z
  .object({
    $schema: z.string().optional(),
    modelStream: modelStreamSchema.optional(),
    permission: permissionSchema.optional(),
    storage: storageSchema.optional(),
    network: networkSchema.optional(),
    features: featuresSchema.optional(),
    memory: memorySchema.optional(),
    mcp: mcpSchema.optional(),
    plugins: pluginsSchema.optional(),
    skills: skillsSchema.optional(),
    skill: skillCommandOverridesSchema.optional(),
    command: skillCommandOverridesSchema.optional(),
    logging: loggingSchema.optional(),
    ui: uiSchema.optional(),
    toolConcurrency: toolConcurrencySchema.optional(),
    modelAnomalyGuard: modelAnomalyGuardSchema.optional(),
    hooks: hooksSchema.optional(),
  })
  .passthrough();

export type ZCodeConfigFile = z.infer<typeof ZCodeConfigFileSchema>;
