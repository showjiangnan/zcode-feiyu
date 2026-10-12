// Modified by ZCode Feiyu.
import type { SessionEvent } from "./session.events.js";
import type { SessionProjection } from "../interfaces/session.port.js";

export type EventProjectionHandler = (
  projection: SessionProjection,
  event: SessionEvent,
) => SessionProjection;
