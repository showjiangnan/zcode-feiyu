// Modified by ZCode Feiyu.
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import type { CommandInbox } from "./command-inbox.js";

export function mapFor<T>(
  this: CommandInbox,
  store: Map<string, Map<string, T>>,
  bucketKey: string,
): Map<string, T> {
  let bucket = store.get(bucketKey);
  if (!bucket) {
    bucket = new Map();
    store.set(bucketKey, bucket);
  }
  return bucket;
}

export function touchSettled(
  this: CommandInbox,
  bucketKey: string,
  commandId: string,
  ack: CommandAck,
): void {
  const bucket = this["mapFor"](this["settled"], bucketKey);
  bucket.delete(commandId);
  bucket.set(commandId, ack);
}

export function rememberSettled(
  this: CommandInbox,
  bucketKey: string,
  commandId: string,
  ack: CommandAck,
): void {
  const bucket = this["mapFor"](this["settled"], bucketKey);
  bucket.delete(commandId);
  bucket.set(commandId, ack);
  while (bucket.size > PROTOCOL_V4_LIMITS.idempotencyTablePerSession) {
    const oldest = bucket.keys().next().value;
    if (oldest === undefined) break;
    bucket.delete(oldest);
  }
}

export function extractCommandId(this: CommandInbox, raw: unknown): string {
  if (typeof raw === "object" && raw !== null && "commandId" in raw) {
    const id = (
      raw as {
        commandId: unknown;
      }
    ).commandId;
    if (typeof id === "string") return id;
  }
  return "";
}
