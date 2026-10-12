// Modified by ZCode Feiyu.
import { watch, type FSWatcher } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import { dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import {
  parseProviderConfigMap,
  parsePersonalModelConfigRules,
  ProviderConfigMap,
  ModelConfigRules,
  type ProviderConfigLayerSnapshot,
  type ProviderSource,
} from "@zcode/provider";

/** 派生投影读取；唯一写入者是对应连接 owner，不接受 Personal 写入覆盖。 */
export class NodeManagedProviderConfigSource implements ProviderSource<ProviderConfigLayerSnapshot> {
  private watcher?: FSWatcher;
  private listeners = new Set<(reason: string) => void>();
  constructor(
    private readonly file: string,
    private readonly watchEnabled = true,
  ) {}
  async read(): Promise<ProviderConfigLayerSnapshot> {
    if (this.watchEnabled && !this.watcher) {
      await mkdir(dirname(this.file), { recursive: true });
      this.watcher = watch(dirname(this.file), (_event, name) => {
        if (name === null || name.toString() === basename(this.file))
          for (const listener of this.listeners) listener("managed-projection");
      });
      this.watcher.on("error", () => {
        for (const listener of this.listeners) listener("managed-watch-error");
      });
    }
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {
        revision: "managed-empty",
        providers: ProviderConfigMap.empty(),
        models: ModelConfigRules.empty(),
      };
    }
    const value = JSON.parse(raw);
    if (value.version !== 1) throw new Error("Unsupported managed provider projection");
    return {
      revision: createHash("sha256").update(raw).digest("hex"),
      providers: parseProviderConfigMap(value.providers),
      models: parsePersonalModelConfigRules(value.models),
    };
  }
  onDidChange(listener: (reason: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  dispose() {
    this.watcher?.close();
    this.listeners.clear();
  }
}
