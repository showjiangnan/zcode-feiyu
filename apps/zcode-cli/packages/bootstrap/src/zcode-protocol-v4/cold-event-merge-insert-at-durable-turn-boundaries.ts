// Modified by ZCode Feiyu.
import type { SessionEvent } from "@zcode/contracts";

export function insertAtDurableTurnBoundaries(input: {
  durableEvents: readonly SessionEvent[];
  trailingEvents: readonly SessionEvent[];
  turnPrefixEvents: ReadonlyMap<string, readonly SessionEvent[]>;
  turnTailEvents: ReadonlyMap<string, readonly SessionEvent[]>;
}): SessionEvent[] {
  const firstIndexByTurnId = new Map<string, number>();
  const tailIndexByTurnId = new Map<string, number>();
  input.durableEvents.forEach((event, index) => {
    if (!event.turnId) return;
    const turnId = String(event.turnId);
    if (!firstIndexByTurnId.has(turnId)) firstIndexByTurnId.set(turnId, index);
    tailIndexByTurnId.set(turnId, index);
  });
  const beforeIndex = new Map<number, SessionEvent[]>();
  for (const [turnId, events] of input.turnPrefixEvents) {
    const firstIndex = firstIndexByTurnId.get(turnId);
    if (firstIndex === undefined) continue;
    beforeIndex.set(firstIndex, [...(beforeIndex.get(firstIndex) ?? []), ...events]);
  }
  const afterIndex = new Map<number, SessionEvent[]>();
  for (const [turnId, events] of input.turnTailEvents) {
    const tailIndex = tailIndexByTurnId.get(turnId);
    if (tailIndex === undefined) continue;
    afterIndex.set(tailIndex, [...(afterIndex.get(tailIndex) ?? []), ...events]);
  }

  const merged: SessionEvent[] = [];
  input.durableEvents.forEach((event, index) => {
    merged.push(...(beforeIndex.get(index) ?? []));
    merged.push(event);
    merged.push(...(afterIndex.get(index) ?? []));
  });
  merged.push(...input.trailingEvents);
  return merged;
}

export function resequence(events: readonly SessionEvent[]): SessionEvent[] {
  return events.map((event, index) => ({ ...event, sequenceNumber: index + 1 }));
}
