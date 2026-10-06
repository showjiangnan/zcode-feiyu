import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  rcsConfigSchema,
  rcsSaveSchema,
  normalizeRcsEndpoint,
  type RcsSettings,
  type RcsSave,
} from "@zcode/shared";

interface ProtectedStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}
interface Stored extends Omit<RcsSettings, "hasKey"> {
  protectedKey?: string;
}

/** 配置与系统保护密钥在同一原子文件提交，避免字段成功而凭据仍属于旧端点。 */
export class RcsSettingsStore {
  private state?: Stored;
  private initialization?: Promise<void>;
  private writes = Promise.resolve();
  constructor(
    private readonly path: string,
    private readonly storage: ProtectedStorage,
  ) {}
  private initialize(): Promise<void> {
    return (this.initialization ??= (async () => {
      try {
        const raw = JSON.parse(await readFile(this.path, "utf8")) as Stored;
        rcsConfigSchema.parse({
          enabled: raw.enabled,
          endpoint: raw.endpoint,
          deviceName: raw.deviceName,
          allowedWorkspaces: raw.allowedWorkspaces,
        });
        if (
          !raw.deviceId ||
          !Number.isInteger(raw.revision) ||
          raw.revision < 0 ||
          (raw.protectedKey !== undefined && typeof raw.protectedKey !== "string")
        )
          throw new Error("RCS_CONFIG_INVALID");
        this.state = raw;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.state = {
          enabled: false,
          endpoint: "",
          deviceName: "ZCode",
          allowedWorkspaces: [],
          deviceId: randomUUID(),
          revision: 0,
        };
        await this.persist(this.state);
      }
    })());
  }
  private requireProtection(): void {
    if (
      !this.storage.isEncryptionAvailable() ||
      this.storage.getSelectedStorageBackend?.() === "basic_text"
    )
      throw new Error("RCS_SYSTEM_PROTECTION_UNAVAILABLE");
  }
  private async persist(state: Stored): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: "wx", flush: true });
      await rename(temp, this.path);
    } finally {
      await rm(temp, { force: true });
    }
  }
  async getSettings(): Promise<RcsSettings> {
    await this.initialize();
    const { protectedKey, ...config } = this.state!;
    return {
      ...config,
      allowedWorkspaces: [...config.allowedWorkspaces],
      hasKey: Boolean(protectedKey),
    };
  }
  async readKey(): Promise<string | undefined> {
    await this.initialize();
    if (!this.state!.protectedKey) return undefined;
    this.requireProtection();
    return this.storage.decryptString(Buffer.from(this.state!.protectedKey, "base64"));
  }
  saveSettings(value: RcsSave): Promise<RcsSettings> {
    const operation = this.writes.then(async () => {
      await this.initialize();
      const input = rcsSaveSchema.parse(value);
      if (input.expectedRevision !== this.state!.revision)
        throw new Error("RCS_CONFIG_REVISION_CONFLICT");
      if (input.key && input.clearKey) throw new Error("RCS_KEY_UPDATE_CONFLICT");
      const endpoint = input.endpoint ? normalizeRcsEndpoint(input.endpoint) : "";
      let protectedKey = this.state!.protectedKey;
      if (input.clearKey) protectedKey = undefined;
      if (input.key) {
        this.requireProtection();
        protectedKey = this.storage.encryptString(input.key).toString("base64");
      }
      if (input.enabled && (!endpoint || !protectedKey || !input.allowedWorkspaces.length))
        throw new Error("RCS_CONFIGURATION_INCOMPLETE");
      const next: Stored = {
        enabled: input.enabled,
        endpoint,
        deviceName: input.deviceName,
        allowedWorkspaces: [...new Set(input.allowedWorkspaces)],
        deviceId: this.state!.deviceId,
        revision: this.state!.revision + 1,
        ...(protectedKey ? { protectedKey } : {}),
      };
      await this.persist(next);
      this.state = next;
      return this.getSettings();
    });
    this.writes = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
}
