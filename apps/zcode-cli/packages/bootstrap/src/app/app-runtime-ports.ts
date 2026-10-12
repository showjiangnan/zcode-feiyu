// Modified by ZCode Feiyu.
import type { ConfigResult } from "@zcode/adapters/config";
import type { AgentRuntimeConfig } from "@zcode/core";
import type { Logger } from "@zcode/contracts";
import { resolvePath } from "@zcode/adapters/config";

import { createNodeExecutionAdapter } from "@zcode/adapters/exec";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createNodeWebFetchHttpClientAdapter } from "@zcode/adapters/http";
import { createJimpImageProcessorAdapter } from "@zcode/adapters/image";

import { createNodeSessionMailboxAdapter } from "@zcode/adapters/mailbox";
import { createMcpAdapter } from "@zcode/adapters/mcp";
import { createPopplerPdfDocumentAdapter } from "@zcode/adapters/pdf";

import { createNodeToolArtifactStore } from "@zcode/adapters/storage";

import { join } from "node:path";

import { StartupTimer } from "../startup-logging.js";

import { isMessageEnabled } from "./app-config-options.js";

import { markStorageAdaptersInitialized } from "./startup-marks.js";
import type { ZCodeAppOptions } from "./types.js";

// 装配阶段复用同一实例与闭包，不另建运行状态或副作用路径。
export function createAppRuntimePorts(input: {
  options: ZCodeAppOptions;
  storageRoot: string;
  cliStorageRoot: string;
  startupTimer: StartupTimer;
  runtimeConfig: AgentRuntimeConfig;
  workingDirectory: string;
  appVersion: string;
  logger: Logger;
  configResult: ConfigResult;
}) {
  const {
    options,
    storageRoot,
    cliStorageRoot,
    startupTimer,
    runtimeConfig,
    workingDirectory,
    appVersion,
    logger,
    configResult,
  } = input;

  const artifactStore =
    options.artifactStore ??
    createNodeToolArtifactStore({
      imageCacheRootDir: join(storageRoot, "cli", "image-cache"),
      pdfCacheRootDir: join(storageRoot, "cli", "pdf-cache"),
      rootDir: join(storageRoot, "cli", "artifacts"),
      videoCacheRootDir: join(storageRoot, "cli", "video-cache"),
    });

  const imageProcessorPort = options.imageProcessorPort ?? createJimpImageProcessorAdapter();

  const messageEnabled = isMessageEnabled(options.env ?? process.env);

  const sessionMailboxPort =
    options.sessionMailboxPort ??
    (messageEnabled
      ? createNodeSessionMailboxAdapter({
          rootDir: resolvePath(
            (options.env ?? process.env).ZCODE_MAILBOX_ROOT ?? "~/.zcode/mailbox",
          ),
        })
      : undefined);

  markStorageAdaptersInitialized({
    cliStorageRoot,
    hasInjectedArtifactStore: options.artifactStore !== undefined,
    hasInjectedSessionStore: options.sessionStore !== undefined,
    startupTimer,
    storageRoot,
  });

  const mcpPort =
    options.mcpPort ??
    (runtimeConfig.mcp?.enabled === false
      ? undefined
      : (options.mcpPortFactory?.({ workingDirectory }) ??
        createMcpAdapter({
          clientVersion: appVersion,
          env: options.env,
          logger,
          network: {
            httpProxy: configResult.config.network.httpProxy,
            noProxy: configResult.config.network.noProxy,
            caCertFile: configResult.config.network.caCertFile,
          },
          workingDirectory,
        })));

  const ownsMcpPort = options.mcpPort === undefined && mcpPort !== undefined;

  const executionPort =
    options.executionPort ??
    createNodeExecutionAdapter({
      onToolExecResource: options.onToolExecResource,
      network: {
        httpProxy: configResult.config.network.httpProxy,
        noProxy: configResult.config.network.noProxy,
        caCertFile: configResult.config.network.caCertFile,
      },
      outputRootDir: join(storageRoot, "cli", "exec"),
      processEnv: options.env ?? process.env,
    });

  const ownsExecutionPort = options.executionPort === undefined;

  const pdfDocumentPort =
    options.pdfDocumentPort ?? createPopplerPdfDocumentAdapter({ executionPort });

  // browser-use 控制端口：仅当宿主（desktop）注入时可用，无本地 fallback（纯 CLI 无浏览器底座）。
  const fileSystemPort =
    options.fileSystemPort ??
    createNodeFileSystemAdapter({
      memoryRootsDirectory: join(cliStorageRoot, "memories", "projects"),
      memoryHistoryDirectory: join(cliStorageRoot, "memory-history"),
    });

  const httpClientPort =
    options.httpClientPort ??
    createNodeWebFetchHttpClientAdapter({
      env: options.env ?? process.env,
      timeoutMs: configResult.config.network.timeout,
      proxyUrl: configResult.config.network.httpProxy,
      noProxy: configResult.config.network.noProxy,
      caCertFile: configResult.config.network.caCertFile,
    });

  const providerEndpointRoutingPort = options.providerEndpointRoutingPort;
  return {
    providerEndpointRoutingPort,
    artifactStore,
    fileSystemPort,
    httpClientPort,
    imageProcessorPort,
    pdfDocumentPort,
    mcpPort,
    executionPort,
    sessionMailboxPort,
    ownsExecutionPort,
    ownsMcpPort,
  };
}
