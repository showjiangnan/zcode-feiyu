// Modified by ZCode Feiyu.
import type { PipSessionEvent } from "@zcode/zcode-cua/pip-session";
import {
  createPipSessionClient,
  type PipSessionClient,
  type PipSessionClientOptions,
} from "@zcode/zcode-cua/pip-session/node";
import { createServiceLogger, type ServiceLogger } from "../logger/serviceLogger.js";
import type { CuaPipSessionService } from "./cuaPipSession.js";

export interface CuaPipPresentationCredentials {
  socketPath: string;
  token?: string;
}

type PipSessionClientResolution =
  | { client: PipSessionClient; skipReason?: never }
  | {
      client: null;
      skipReason:
        | "service-disabled"
        | "service-disposed"
        | "credentials-unavailable"
        | "transport-disabled";
    };

function eventLogContext(event: PipSessionEvent): Record<string, unknown> {
  if (event.kind === "focus-changed") {
    return {
      kind: event.kind,
      revision: event.revision,
      sessionId: event.sessionId,
      sourceWindowId: event.sourceWindowId,
    };
  }
  return {
    eventId: event.eventId,
    kind: event.kind,
    sequenceNumber: event.sequenceNumber,
    sessionId: event.sessionId,
    ...(event.kind === "session-closed" ? {} : { turnId: event.turnId }),
    ...(event.kind === "turn-ended" ? { outcome: event.outcome } : {}),
  };
}

export function createCuaPipSessionService(options: {
  enabled: boolean;
  resolveCredentials: () => Promise<CuaPipPresentationCredentials | undefined>;
  createClient?: (options: PipSessionClientOptions) => PipSessionClient;
  logger?: ServiceLogger;
}): CuaPipSessionService {
  const logger = options.logger ?? createServiceLogger("cua-pip-session");
  const clientFactory = options.createClient ?? createPipSessionClient;
  let current: {
    key: string;
    client: PipSessionClient;
  } | null = null;
  let disabledTransportKey: string | null = null;
  let tail: Promise<void> = Promise.resolve();
  let disposed = false;
  const getClient = async (): Promise<PipSessionClientResolution> => {
    if (!options.enabled) return { client: null, skipReason: "service-disabled" };
    if (disposed) return { client: null, skipReason: "service-disposed" };
    const credentials = await options.resolveCredentials();
    if (disposed) return { client: null, skipReason: "service-disposed" };
    if (!credentials) return { client: null, skipReason: "credentials-unavailable" };
    const key = `${credentials.socketPath}:${credentials.token || ""}`;
    if (disabledTransportKey === key) {
      return { client: null, skipReason: "transport-disabled" };
    }
    if (current?.key === key) return { client: current.client };
    current?.client.close();
    const client = clientFactory({
      socketPath: credentials.socketPath,
      token: credentials.token,
      onDiagnostic: (diagnostic) => {
        const message = `[cua-pip-session] ${diagnostic.code}: ${diagnostic.message}`;
        if (diagnostic.code === "version_mismatch") logger.warn(undefined, message);
        else logger.debug(undefined, message);
      },
    });
    current = { key, client };
    try {
      await client.connect();
      if (disposed) {
        client.close();
        if (current?.client === client) current = null;
        return { client: null, skipReason: "service-disposed" };
      }
      return { client };
    } catch (error) {
      if (current?.client === client) current = null;
      client.close();
      if ((error as { code?: unknown }).code === "version_mismatch") {
        disabledTransportKey = key;
      }
      throw error;
    }
  };

  const publish = (event: PipSessionEvent): Promise<void> => {
    // 预览源由首次真实观察创建；开场/焦点事件不能创建第二份控制或排队补发。
    if (
      disposed ||
      !["turn-ended", "turn-completed", "turn-failed", "session-closed"].includes(event.kind)
    )
      return Promise.resolve();
    const operation = tail.then(async () => {
      try {
        const resolution = await getClient();
        if (disposed) return;
        if (!resolution.client) {
          logger.debug(undefined, "[cua-pip-session] no control transport to clean up", {
            ...eventLogContext(event),
            skipReason: resolution.skipReason,
          });
          return;
        }
        const result = await resolution.client.send(event);
        // 只记录实际终止清理回执；不把未消费的焦点/开场事件标为 applied。
        logger.info(undefined, "[cua-pip-session] event delivery acknowledged", {
          ...eventLogContext(event),
          applied: result.applied,
          reason: result.reason,
        });
      } catch (error) {
        logger.warn(undefined, "[cua-pip-session] event delivery failed", {
          ...eventLogContext(event),
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    });
    tail = operation;
    return operation;
  };

  return {
    publishFocus: publish,
    publishLifecycle: publish,
    dispose() {
      disposed = true;
      current?.client.close();
      current = null;
    },
  };
}
