import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function formatCommand(command, args) {
  return [command, ...args].join(" ");
}

export function run(command, args, { cwd, env, quiet = false, input } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: quiet ? [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] : "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const details = quiet
      ? `\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`
      : "";
    throw new Error(`${formatCommand(command, args)} failed with code ${result.status}${details}`);
  }

  return result;
}

export function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${formatCommand(command, args)} failed with code ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function downloadAndExtractSources({ sources, workDir, env, quiet }) {
  const archivesDir = join(workDir, "archives");
  const sourcesDir = join(workDir, "sources");
  mkdirSync(archivesDir, { recursive: true });
  mkdirSync(sourcesDir, { recursive: true });

  const sourcePaths = {};
  for (const source of sources) {
    console.log(`==> Download ${source.id} ${source.version}`);
    const archivePath = join(archivesDir, `${source.id}.tar.gz`);
    run("curl", ["-L", "--fail", "--retry", "3", "-o", archivePath, source.url], {
      env,
      quiet,
    });

    const actualSha256 = sha256(archivePath);
    if (actualSha256 !== source.sha256) {
      throw new Error(
        `${source.id} archive checksum mismatch: expected ${source.sha256}, received ${actualSha256}`,
      );
    }

    const sourcePath = join(sourcesDir, source.id);
    mkdirSync(sourcePath, { recursive: true });
    run("tar", ["-xzf", archivePath, "-C", sourcePath, "--strip-components=1"], {
      env,
      quiet,
    });
    sourcePaths[source.id] = sourcePath;
  }

  return sourcePaths;
}
