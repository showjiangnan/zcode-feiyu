import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { RCS_SERVICE_MANIFEST } from "../packages/shared/src/rcsServiceManifest.ts";
import {
  rcsControlSchema,
  rcsHostSchema,
  rcsGrantSchema,
  rcsWorkspaceSchema,
} from "../packages/shared/src/rcs.ts";
import { z } from "zod";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const destination = resolve(process.argv[2] ?? "../zcode-rcs");
for (const directory of ["sdk", "protocol", "web"])
  await mkdir(join(destination, directory), { recursive: true });
await build({
  entryPoints: [join(root, "packages/client/src/rcsPublicSdk.ts")],
  outfile: join(destination, "sdk/index.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
});
const variants = Object.entries(RCS_SERVICE_MANIFEST)
  .filter(([, v]) => v.methods.length)
  .map(
    ([service, value]) =>
      `{ service: ${JSON.stringify(service)}; method: ${value.methods.map(JSON.stringify).join(" | ")}; args?: unknown[] }`,
  );
const events = Object.entries(RCS_SERVICE_MANIFEST)
  .filter(([, v]) => v.events.length)
  .map(
    ([service, value]) =>
      `{ service: ${JSON.stringify(service)}; event: ${value.events.map(JSON.stringify).join(" | ")}; arg?: unknown }`,
  );
const template = await readFile(
  join(root, "packages/client/src/rcs-sdk-public.d.ts.template"),
  "utf8",
);
await writeFile(
  join(destination, "sdk/index.d.ts"),
  template
    .replace("PUBLIC_REQUEST_UNION", variants.join("\n | "))
    .replace("PUBLIC_EVENT_UNION", events.join("\n | ")),
);
await writeFile(
  join(destination, "sdk/package.json"),
  JSON.stringify(
    {
      name: "@zcode-feiyu/rcs-sdk",
      version: "1.0.0",
      type: "module",
      exports: { ".": { types: "./index.d.ts", import: "./index.js" } },
      files: ["index.js", "index.d.ts", "LICENSE", "THIRD-PARTY-NOTICES.md"],
      license: "Apache-2.0",
    },
    null,
    2,
  ) + "\n",
);
await cp(join(root, "LICENSE"), join(destination, "sdk/LICENSE"));
await cp(join(root, "THIRD-PARTY-NOTICES.md"), join(destination, "sdk/THIRD-PARTY-NOTICES.md"));
const json = (path, value) =>
  writeFile(join(destination, "protocol", path), JSON.stringify(value, null, 2) + "\n");
await json("services.json", {
  bridgeVersion: 1,
  rpcCodec: 1,
  agentWire: 3,
  services: RCS_SERVICE_MANIFEST,
});
for (const [name, schema] of Object.entries({
  "desktop-control": rcsControlSchema,
  host: rcsHostSchema,
  workspace: rcsWorkspaceSchema,
  grant: rcsGrantSchema,
}))
  await json(`${name}.schema.json`, z.toJSONSchema(schema));
for (const [name, field] of [
  ["request", "method"],
  ["subscription", "event"],
])
  await json(`${name}.schema.json`, {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    oneOf: Object.entries(RCS_SERVICE_MANIFEST)
      .filter(([, v]) => v[field === "method" ? "methods" : "events"].length)
      .map(([service, value]) => ({
        type: "object",
        additionalProperties: false,
        required: ["service", field],
        properties: {
          service: { const: service },
          [field]: { enum: value[field === "method" ? "methods" : "events"] },
          ...(field === "method" ? { args: { type: "array" } } : { arg: {} }),
        },
      })),
  });
// 发布既有 V4 的 schema；服务参数仍由 Host 的相同运行时校验器处理。
const schemaModule = join(root, ".tmp", "rcs-protocol-schema.mjs");
await mkdir(join(root, ".tmp"), { recursive: true });
await build({
  stdin: {
    contents: 'export * from "./packages/shared/src/zcode-protocol-v4/index.ts";',
    resolveDir: root,
  },
  outfile: schemaModule,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
});
try {
  const protocol = await import(pathToFileURL(schemaModule).href);
  const schemas = {};
  for (const [name, value] of Object.entries(protocol)) {
    if (name.endsWith("Schema") && value && typeof value.safeParse === "function")
      schemas[name] = z.toJSONSchema(value, { io: "input", unrepresentable: "any" });
  }
  if (protocol.commandPayloadSchemas)
    for (const [name, value] of Object.entries(protocol.commandPayloadSchemas))
      schemas[`command:${name}`] = z.toJSONSchema(value, { io: "input", unrepresentable: "any" });
  await json("v4.schema.json", { bridgeVersion: 1, rpcCodec: 1, agentWire: 3, schemas });
} finally {
  await rm(schemaModule, { force: true });
}
// 交付的是共享 Web 的生产 bundle；源码与构建命令保留在主仓库，避免维护第二份界面。
await rm(join(destination, "web"), { recursive: true, force: true });
await cp(join(root, "packages/web/dist"), join(destination, "web"), {
  recursive: true,
  filter: (path) => !path.endsWith(".map"),
});
await writeFile(
  join(destination, "web/build-info.json"),
  JSON.stringify(
    {
      version: JSON.parse(await readFile(join(root, "package.json"), "utf8")).version,
      source: "https://github.com/showjiangnan/zcode-feiyu",
      entry: "packages/web/src/rcs/RcsApp.tsx",
      bridgeVersion: 1,
      rpcCodec: 1,
      agentWire: 3,
    },
    null,
    2,
  ) + "\n",
);
console.log("RCS Web, standalone SDK declarations, manifest and schemas exported");
