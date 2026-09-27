import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

export async function loadEndpointEnv({
  root = resolve(import.meta.dirname, ".."),
  env = process.env,
} = {}) {
  const values = {};
  for (const name of [".env", ".env.local"]) {
    try {
      Object.assign(values, parseEnv(await readFile(resolve(root, name), "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return { ...values, ...env };
}
