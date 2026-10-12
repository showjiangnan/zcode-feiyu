// Modified by ZCode Feiyu.
import type { Logger } from "@zcode/contracts";
import { V4CommandExecutor } from "../zcode-protocol-v4/commands/executor.js";

import type { V4CommandCoreHost } from "../zcode-protocol-v4/commands/types.js";

import { PersistentCommandIndex } from "../zcode-protocol-v4/persistent-command-index.js";

import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";

export interface V4GatewaySurfaceInput {
  context: ZCodeProtocolAgentServerContext;
  log: Logger | undefined;
  autoDrainV4QueueIfReady: (record: ZCodeProtocolSessionRecord) => Promise<void>;
  loadStoredSessionSummaries: (
    workspaceId: string,
    legacyTaskIds?: readonly string[],
  ) => Promise<
    {
      title: string;
      titleSource: NonNullable<"default" | "custom" | "generated" | undefined>;
      phase: "completedSuccess";
      sessionEnded: boolean;
      hasBackgroundWork: boolean;
      lastActivityAt: number;
      createdAt: number;
      parentSessionId?: string | undefined;
      sessionId: string;
      workspaceId: string;
    }[]
  >;
  nativeExecutor: V4CommandExecutor;
  coreHost: V4CommandCoreHost;
  persistentCommands: PersistentCommandIndex;
}
