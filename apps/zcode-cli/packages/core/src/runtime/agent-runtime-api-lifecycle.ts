// Modified by ZCode Feiyu.
import { type OrchestrationMode, type OrchestrationState } from "@zcode/shared/zcode-protocol-v4";

import { type ProjectMemoryReviewOutcome } from "./helpers/project-memory-review.js";

export interface AgentRuntimeLifecycleApi {
  closeBrowserSession(): Promise<void>;
  recoverProjectMemory(): Promise<void>;
  beginShutdown(): void;
  updateProjectMemoryPreferences(input: {
    policyRevision?: number;
    continuityPolicy?: import("@zcode/shared").ContinuityPolicy;
    enabled: boolean;
    extractionEnabled: boolean;
    reviewEnabled: boolean;
  }): Promise<void>;
  reviewProjectMemoryNow(sourceSessionId?: string): Promise<ProjectMemoryReviewOutcome>;
  getOrchestrationState(): OrchestrationState;
  getProactiveCausalContext():
    | import("@zcode/shared/zcode-protocol-v4").ProactiveCausalContext
    | undefined;
  controlProactiveWork(
    action: "start" | "pause" | "stop",
    subscriptions?: import("@zcode/shared/zcode-protocol-v4").ProactiveSubscription[],
  ): Promise<OrchestrationState>;
  authorizeProactiveCommand(commandId: string): Promise<void>;
  requestOrchestrationMode(mode: OrchestrationMode): Promise<OrchestrationState>;
  cancelProjectMemoryReview(expectedReviewId?: string): boolean;
}
