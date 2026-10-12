// Modified by ZCode Feiyu.
import type { SessionEvent } from "./session.events.js";
import type { SessionProjection } from "../interfaces/session.port.js";
import { initialSessionProjection } from "./event-reducer-helpers.js";
import type { EventProjectionHandler } from "./event-reducer-handler.js";
import { createLifecycleProjectionHandlers } from "./event-reducer-lifecycle.js";
import { createModelGoalProjectionHandlers } from "./event-reducer-model-goal.js";
import { createSteerProjectionHandlers } from "./event-reducer-steer.js";
import { createToolPermissionProjectionHandlers } from "./event-reducer-tool-permission.js";

export class EventReducer {
  reduce(events: SessionEvent[]): SessionProjection {
    return events.reduce((projection, event) => this.apply(projection, event), {
      ...initialSessionProjection,
      id: events[0]?.sessionId ?? ("unknown" as any),
    } as SessionProjection);
  }

  apply(projection: SessionProjection, event: SessionEvent): SessionProjection {
    const handler = this.handlers[event.type];
    if (handler) {
      return handler(projection, event);
    }
    return {
      ...projection,
      updatedAt: event.timestamp,
    };
  }
  // 将事件处理按投影职责拆分，统一 dispatch 和未知事件时间更新仍由本 reducer 持有。
  private handlers: Record<string, EventProjectionHandler> = {
    ...createLifecycleProjectionHandlers(),
    ...createModelGoalProjectionHandlers(),
    ...createSteerProjectionHandlers(),
    ...createToolPermissionProjectionHandlers(),
  };
}

// -----------------------------------------------
// Utility Functions
// -----------------------------------------------

export function reduce(events: SessionEvent[]): SessionProjection {
  return new EventReducer().reduce(events);
}

export function apply(projection: SessionProjection, event: SessionEvent): SessionProjection {
  return new EventReducer().apply(projection, event);
}
