// Modified by ZCode Feiyu.
import { readFile, mkdir, lstat, chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import { subscriptionStoreSchema, emptySubscriptionStore } from "../domain/records.js";
import { ChatGPTSubscriptionError } from "../domain/errors.js";
import type { SubscriptionCipher, SubscriptionStorePort } from "../app/ports.js";

export function createSubscriptionPrivateStore(
  directory: string,
  cipher: SubscriptionCipher,
): SubscriptionStorePort {
  const file = join(directory, "connections.encrypted.json");
  const hostFile = join(directory, "host.json");
  const assertAvailable = () => {
    if (!cipher.available()) throw new ChatGPTSubscriptionError("secure_storage_unavailable");
  };
  async function prepareDirectory() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.platform !== "win32" && process.getuid && info.uid !== process.getuid())
    )
      throw new ChatGPTSubscriptionError("credential_store_unsafe");
    if (process.platform !== "win32") await chmod(directory, 0o700);
  }
  async function readPrivateFile(path: string) {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 8 * 1024 * 1024 ||
      (process.platform !== "win32" && process.getuid && info.uid !== process.getuid())
    )
      throw new ChatGPTSubscriptionError("credential_store_unsafe");
    if (process.platform !== "win32") await chmod(path, 0o600);
    return readFile(path, "utf8");
  }
  async function read() {
    assertAvailable();
    await prepareDirectory();
    let raw: string;
    try {
      raw = await readPrivateFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySubscriptionStore();
      throw new ChatGPTSubscriptionError("credential_store_unreadable");
    }
    try {
      const envelope = JSON.parse(raw);
      if (
        envelope.version !== 1 ||
        envelope.cipherId !== cipher.id ||
        typeof envelope.ciphertext !== "string"
      )
        throw new Error("invalid envelope");
      return subscriptionStoreSchema.parse(JSON.parse(await cipher.decrypt(envelope.ciphertext)));
    } catch {
      throw new ChatGPTSubscriptionError("credential_store_corrupt");
    }
  }
  return {
    read,
    async hostId() {
      await prepareDirectory();
      return withFileLock(hostFile, async () => {
        try {
          const value = JSON.parse(await readPrivateFile(hostFile));
          if (value.version !== 1 || !/^urn:uuid:[a-f0-9-]{36}$/u.test(value.hostId))
            throw new Error("invalid host identity");
          return value.hostId as string;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            throw new ChatGPTSubscriptionError("host_identity_corrupt");
          const hostId = `urn:uuid:${randomUUID()}`;
          await atomicWritePrivateTextFile(hostFile, JSON.stringify({ version: 1, hostId }));
          return hostId;
        }
      });
    },
    async transaction(run) {
      assertAvailable();
      await prepareDirectory();
      return withFileLock(
        file,
        async () =>
          run(await read(), async (next) => {
            assertAvailable();
            const body = subscriptionStoreSchema.parse(next);
            const ciphertext = await cipher.encrypt(JSON.stringify(body));
            await atomicWritePrivateTextFile(
              file,
              JSON.stringify({ version: 1, cipherId: cipher.id, ciphertext }),
            );
          }),
        { lockMaxWaitMs: 180_000 },
      );
    },
  };
}
