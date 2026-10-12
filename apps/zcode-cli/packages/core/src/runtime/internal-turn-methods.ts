// Modified by ZCode Feiyu.
import type { AgentRuntimeTurnMethodsExecution } from "./internal-turn-methods-api-execution.js";
import type { AgentRuntimeTurnMethodsCollaboration } from "./internal-turn-methods-api-collaboration.js";
import type { AgentRuntimeTurnMethodsSession } from "./internal-turn-methods-api-session.js";

export interface AgentRuntimeTurnMethods
  extends
    AgentRuntimeTurnMethodsExecution,
    AgentRuntimeTurnMethodsCollaboration,
    AgentRuntimeTurnMethodsSession {}
