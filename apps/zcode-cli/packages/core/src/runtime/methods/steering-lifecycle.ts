// Modified by ZCode Feiyu.
import {
  CoreErrorType,
  SessionEventType,
  createCoreError,
  createSessionEvent,
  traceContextToLogContext,
} from "../deps.js";
import type { TraceContext, TurnSteerRejectReason, TurnSteerResult, TurnId } from "../deps.js";

import type { ActiveTurnKind, ActiveTurnSteeringState } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  invalidateSuggestedPrompt,
  startPendingSuggestedPrompt,
} from "../suggested-prompt/runtime.js";

export function beginActiveTurn(
  this: AgentRuntimeInternal,
  turnId: TurnId,
  traceContext: TraceContext,
  kind: ActiveTurnKind,
  steerable: boolean,
  options?: { inputId?: string },
): ActiveTurnSteeringState {
  if (this.activeTurn) {
    throw createTurnInProgressError(kind, this.activeTurn.turnId, turnId);
  }
  const reservation = this.activeTurnStartReservation;
  if (reservation && reservation.turnId !== turnId) {
    throw createTurnInProgressError(kind, reservation.turnId, turnId);
  }

  const activeTurn: ActiveTurnSteeringState = {
    goalStateChangeReminderDeferralOpen: false,
    kind,
    pendingInputs: [],
    steerable,
    traceContext,
    turnId,
    ...(options?.inputId === undefined ? {} : { inputId: options.inputId }),
  };
  invalidateSuggestedPrompt(this);
  this.activeTurnStartReservation = undefined;
  this.activeTurn = activeTurn;
  return activeTurn;
}

export function reserveTurnStart(
  this: AgentRuntimeInternal,
  turnId: TurnId,
  traceContext: TraceContext,
  kind: ActiveTurnKind,
): void {
  if (this.activeTurn) {
    throw createTurnInProgressError(kind, this.activeTurn.turnId, turnId);
  }
  if (this.activeTurnStartReservation) {
    throw createTurnInProgressError(kind, this.activeTurnStartReservation.turnId, turnId);
  }
  this.activeTurnStartReservation = {
    kind,
    traceContext,
    turnId,
  };
  invalidateSuggestedPrompt(this);
}

export function releaseTurnStart(this: AgentRuntimeInternal, turnId: TurnId): void {
  if (this.activeTurnStartReservation?.turnId === turnId) {
    this.activeTurnStartReservation = undefined;
  }
}

export function finishActiveTurn(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState | undefined,
): void {
  if (activeTurn !== undefined && this.activeTurn === activeTurn) {
    this.activeTurn = undefined;
    startPendingSuggestedPrompt(this);
  }
}

export function createPendingInputId(this: AgentRuntimeInternal, turnId: TurnId): string {
  this.pendingInputSequence += 1;
  return `pending_${turnId}_${this.pendingInputSequence}`;
}

export function createTurnInProgressError(
  kind: ActiveTurnKind,
  activeTurnId: TurnId,
  nextTurnId: TurnId,
): Error {
  return createCoreError(
    CoreErrorType.TurnInProgress,
    `Cannot start ${kind} turn while another turn is active`,
    {
      context: {
        activeTurnId,
        nextTurnId,
      },
      recoverable: true,
    },
  );
}

export async function rejectTurnSteer(
  this: AgentRuntimeInternal,
  reason: TurnSteerRejectReason,
  options: {
    activeTurn?: ActiveTurnSteeringState;
    expectedTurnId?: TurnId;
    inputPreview?: string;
    inputSize?: number;
    traceContext?: TraceContext;
  },
): Promise<TurnSteerResult> {
  const traceContext =
    options.activeTurn?.traceContext ?? options.traceContext ?? this.rootTraceContext;
  const event = createSessionEvent(
    SessionEventType.TurnSteerRejected,
    this.sessionId,
    {
      activeTurnId: options.activeTurn?.turnId,
      expectedTurnId: options.expectedTurnId,
      inputPreview: options.inputPreview,
      inputSize: options.inputSize,
      reason,
    },
    {
      traceId: traceContext.traceId,
      turnId: options.activeTurn?.turnId,
    },
  );
  await this.appendEvent(event, traceContext);
  this.logger?.debug("Turn steer rejected", {
    ...traceContextToLogContext(traceContext),
    activeQueueLength: options.activeTurn?.pendingInputs.length,
    activeTurnId: options.activeTurn?.turnId,
    activeTurnKind: options.activeTurn?.kind,
    activeTurnSteerable: options.activeTurn?.steerable,
    event: "turn.steer.rejected",
    expectedTurnId: options.expectedTurnId,
    inputPreview: options.inputPreview,
    inputSize: options.inputSize,
    module: "core.runtime",
    reason,
    status: "completed",
  });
  return {
    activeTurnId: options.activeTurn?.turnId,
    kind: "rejected",
    reason,
  };
}
