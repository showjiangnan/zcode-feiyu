// Modified by ZCode Feiyu.
import { PersistentCommandIndex } from "../zcode-protocol-v4/persistent-command-index.js";

import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";

export interface V4CoreHostInput {
  context: ZCodeProtocolAgentServerContext;
  queuedTurnExecutions: Map<
    string,
    Map<
      string,
      {
        selectionScope: "execution";
        memoryExtraction?: "skip" | undefined;
        requestAuth?:
          | {
              apiKey?: string | undefined;
              apiKeyId?: string | undefined;
              accountScope?: string | undefined;
              headers?: Record<string, string> | undefined;
            }
          | undefined;
        subagents?: { foregroundModel: "submission"; background: "deny" } | undefined;
        selectionFallback?:
          | {
              providerId: string;
              rules: {
                reason: "highspeed_card_expired" | "highspeed_request_failed";
                providerErrorCode?: string | undefined;
              }[];
              target?:
                | {
                    providerId: string;
                    modelId: string;
                    options?: { reasoningLevel?: string | undefined } | undefined;
                  }
                | undefined;
            }
          | undefined;
      }
    >
  >;
  persistentCommands: PersistentCommandIndex;
  autoDrainV4QueueIfReady: (record: ZCodeProtocolSessionRecord) => Promise<void>;
}
