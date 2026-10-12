// Modified by ZCode Feiyu.
import { createConfig } from "@zcode/adapters/config";
import { createNodeLoggerFactory } from "@zcode/adapters/logging";

import {
  createRootTraceContext,
  createSessionId,
  traceContextToLogContext,
} from "@zcode/contracts";

import { createModelTelemetry } from "@zcode/telemetry";
import { resolve } from "node:path";

import { StartupTimer, startupNow } from "../startup-logging.js";
import { createConfigCliOverrides, resolveEffectiveConfigResult } from "./app-config-options.js";

import { markConfigurationLoaded, startAppStartup } from "./startup-marks.js";
import type { ZCodeAppOptions } from "./types.js";

// 装配阶段复用同一实例与闭包，不另建运行状态或副作用路径。
export function createAppInitialization(input: { options: ZCodeAppOptions }) {
  const { options } = input;

  const startupStartedAt = startupNow();
  const appVersion = options.version ?? "0.0.0";
  const sessionId = options.sessionId ?? createSessionId();
  const traceContext = options.traceContext ?? createRootTraceContext({ sessionId });
  const workingDirectory = resolve(options.runtimeConfig?.workingDirectory ?? process.cwd());
  const configResult = resolveEffectiveConfigResult(
    createConfig({
      env: options.env,
      projectConfigPath: options.projectConfigPath,
      workingDirectory,
      workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
      skipUserConfig: options.skipUserConfig,
      userConfigPath: options.userConfigPath,
      cliOverrides: createConfigCliOverrides(options),
    }),
    options,
  );
  const loggerFactory = options.loggerFactory ?? createNodeLoggerFactory({ env: options.env });
  const logger = loggerFactory.createLogger("zcode").child({
    ...traceContextToLogContext(traceContext),
    module: "bootstrap",
  });
  const startupTimer = new StartupTimer(
    logger,
    {
      ...traceContextToLogContext(traceContext),
      module: "bootstrap",
      startupKind: "zcode_app",
    },
    startupStartedAt,
  );
  startAppStartup({
    hasInjectedModelAdapter: options.modelAdapter !== undefined,
    resume: options.resume === true,
    startupTimer,
  });
  markConfigurationLoaded({
    configResult,
    startupTimer,
  });
  const modelLogger = loggerFactory.createLogger("zcode").child({
    ...traceContextToLogContext(traceContext),
    module: "adapters.model",
  });
  const modelTelemetry = createModelTelemetry({
    owner: options.telemetryOwner,
    sessionId,
  });
  return {
    configResult,
    traceContext,
    logger,
    workingDirectory,
    startupTimer,
    sessionId,
    appVersion,
    modelLogger,
    modelTelemetry,
    loggerFactory,
  };
}
