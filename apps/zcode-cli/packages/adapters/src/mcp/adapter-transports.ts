// Modified by ZCode Feiyu.
import {
  ClientCredentialsProvider,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type AuthProvider,
  type OAuthClientProvider,
} from "@modelcontextprotocol/client";
import type { McpServerConfig } from "@zcode/contracts";
import { OFFICIAL_MCP_AUTH_META_KEY } from "@zcode/shared";
import { resolve } from "node:path";
import {
  createSharedZCodeCredentialStore,
  type SharedZCodeCredentialStore,
} from "../auth/shared-credentials.js";
import type { NodeMcpAdapter } from "./adapter-owner.js";
import {
  MCP_STDIO_STDERR_LOG_MAX_CHARS,
  McpTransport,
  createBoundedTextBuffer,
  createOAuthAuthorizationStatus,
  isOfficialAuthConfig,
  resolveAuthorizationCodeOAuthConfig,
  sanitizeMcpStdioStderr,
} from "./adapter-shared.js";
import { buildMcpStdioEnv, createMcpTransportFetch } from "./network.js";
import { createMcpOAuthTokenProvider } from "./oauth-provider.js";
import { createCredentialKeyPrefix, type McpOAuthRuntimeOptions } from "./oauth.js";
import { ProcessTreeStdioClientTransport } from "./stdio-transport.js";

export async function createTransport(
  this: NodeMcpAdapter,
  config: McpServerConfig,
  serverName: string,
  generation: number,
  _oauthAuthorizationTimeoutMs?: number,
  workingDirectory?: string,
  signal?: AbortSignal,
): Promise<{ transport: McpTransport }> {
  if (config.type === "stdio") {
    return {
      transport: new ProcessTreeStdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        cwd: config.cwd
          ? resolve(workingDirectory ?? this.workingDirectory ?? process.cwd(), config.cwd)
          : (workingDirectory ?? this.workingDirectory),
        env: {
          ...buildMcpStdioEnv({ env: this.env, network: this.network }),
          ...config.env,
        },
        stderr: "pipe",
        ...(isOfficialAuthConfig(config) && config.official
          ? {
              requestMetaProvider: async () => {
                const authMeta = await this.resolveOfficialStdioAuthMeta(
                  serverName,
                  config,
                  signal,
                );
                return authMeta ? { [OFFICIAL_MCP_AUTH_META_KEY]: authMeta } : undefined;
              },
            }
          : {}),
      }),
    };
  }

  const fetch = createMcpTransportFetch({
    env: this.env,
    network: this.network,
  });
  if (config.type === "http") {
    const officialAuthFetch = this.createOfficialAuthFetch(config, serverName, generation);
    return {
      transport: new StreamableHTTPClientTransport(new URL(config.url), {
        // 官方鉴权路径下 authProvider 必为 undefined：不落 OAuth 凭据、
        // 不起 localhost 回调 server、401/403 不转授权流程。
        authProvider: this.createOAuthClientProvider(serverName, config),
        fetch: officialAuthFetch ?? fetch,
        requestInit: config.headers ? { headers: config.headers } : undefined,
      }),
    };
  }

  return {
    transport: new SSEClientTransport(new URL(config.url), {
      authProvider: this.createOAuthClientProvider(serverName, config),
      fetch,
      requestInit: config.headers ? { headers: config.headers } : undefined,
    }),
  };
}

export function createOAuthClientProvider(
  this: NodeMcpAdapter,
  serverName: string,
  config: McpServerConfig,
): AuthProvider | OAuthClientProvider | undefined {
  if (config.type === "stdio") return undefined;
  // 官方鉴权与 OAuth 互斥：官方 MCP 的失败只能由 ZCode 登录/套餐解决，
  // 交出任何 authProvider 都会让 401 误转成 MCP 授权流程。
  if (isOfficialAuthConfig(config)) return undefined;
  const authorizationCodeOAuthConfig = resolveAuthorizationCodeOAuthConfig(config);
  if (authorizationCodeOAuthConfig) {
    return createMcpOAuthTokenProvider({
      config: authorizationCodeOAuthConfig,
      credentialStore: this.resolveCredentialStore(),
      fetchFn: createMcpTransportFetch({ env: this.env, network: this.network }),
      keyPrefix: createCredentialKeyPrefix(serverName, config.url, authorizationCodeOAuthConfig),
      ...(this.logger ? { logger: this.logger } : {}),
      serverName,
      serverUrl: config.url,
    });
  }
  if (config.oauth?.type === "client_credentials") {
    return new ClientCredentialsProvider({
      clientId: config.oauth.clientId,
      clientName: config.oauth.clientName ?? `${this.clientName}-${serverName}`,
      clientSecret: config.oauth.clientSecret,
      scope: config.oauth.scope,
    });
  }
  return undefined;
}

export function resolveCredentialStore(this: NodeMcpAdapter): SharedZCodeCredentialStore {
  this.credentialStore ??= this.mcpOAuth?.credentialStore ?? createSharedZCodeCredentialStore();
  return this.credentialStore;
}

export function createAuthorizationCodeOAuthOptions(
  this: NodeMcpAdapter,
  config: McpServerConfig,
  serverName: string,
  generation: number,
  oauthAuthorizationTimeoutMs?: number,
): McpOAuthRuntimeOptions | undefined {
  if (config.type === "stdio") return this.mcpOAuth;
  return {
    ...this.mcpOAuth,
    authorizationTimeoutMs: oauthAuthorizationTimeoutMs ?? this.mcpOAuth?.authorizationTimeoutMs,
    onAuthorizationRequired: async (context) => {
      this.updateCurrentRecordStatus(serverName, generation, {
        authorization: createOAuthAuthorizationStatus(context),
        status: "connecting",
      });
      await this.mcpOAuth?.onAuthorizationRequired?.(context);
    },
  };
}

export function attachStdioLogging(
  this: NodeMcpAdapter,
  name: string,
  transport: McpTransport,
): () => string | undefined {
  const stderrBuffer = createBoundedTextBuffer(MCP_STDIO_STDERR_LOG_MAX_CHARS);
  const stderr = (
    transport as {
      stderr?: { on(event: "data", handler: (chunk: Buffer) => void): void };
    }
  ).stderr;
  stderr?.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderrBuffer.append(text);
    this.logger?.debug("MCP stdio stderr", {
      event: "mcp.stdio.stderr",
      mcpServerName: name,
      stderr: sanitizeMcpStdioStderr(text).slice(0, MCP_STDIO_STDERR_LOG_MAX_CHARS),
    });
  });
  return () => {
    const text = stderrBuffer.read();
    if (!text) return undefined;
    // 生产日志里单独的 Connection closed 无法定位 stdio MCP 子进程退出原因。
    // 只在失败事件附带尾部 stderr，并先脱敏，避免把凭据或高频输出写入生产日志。
    return sanitizeMcpStdioStderr(text).slice(-MCP_STDIO_STDERR_LOG_MAX_CHARS);
  };
}
