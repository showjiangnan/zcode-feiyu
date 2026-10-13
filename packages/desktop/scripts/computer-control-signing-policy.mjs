// Modified by ZCode Feiyu.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const exec = promisify(execFile);

export function resolveMacControlDistribution(env = process.env) {
  const mode = env.ZCODE_MAC_DISTRIBUTION || "local";
  if (!["local", "developer-id"].includes(mode)) throw new Error("Unknown macOS distribution mode");
  const identity = env.APPLE_SIGNING_IDENTITY || env.CSC_NAME || "-";
  if (mode === "developer-id") {
    if (
      !identity.startsWith("Developer ID Application: ") ||
      !/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID || "") ||
      !env.ZCODE_NOTARYTOOL_PROFILE?.trim()
    )
      throw new Error(
        "Developer ID distribution requires a stable Developer ID Application identity, APPLE_TEAM_ID and ZCODE_NOTARYTOOL_PROFILE",
      );
  }
  return { mode, identity, teamId: env.APPLE_TEAM_ID, notaryProfile: env.ZCODE_NOTARYTOOL_PROFILE };
}
export async function readMacControlSignature(path, runner = exec) {
  await runner("/usr/bin/codesign", ["--verify", "--deep", "--strict", path]);
  const report = await runner("/usr/bin/codesign", ["-dv", "--verbose=4", path]);
  const teamId = report.stderr.match(/TeamIdentifier=([A-Z0-9]{10})(?:\n|$)/)?.[1];
  return {
    mode:
      report.stderr.includes("Authority=Developer ID Application:") && teamId
        ? "developer-id"
        : "ad-hoc",
    teamId: teamId || null,
    tccIdentity: teamId ? "team-designated-requirement" : "per-build",
  };
}
export async function finishMacControlDistribution(appPath, helperPath, policy, runner = exec) {
  if (policy.mode !== "developer-id") return;
  const app = await readMacControlSignature(appPath, runner);
  const helper = await readMacControlSignature(helperPath, runner);
  if (
    app.mode !== "developer-id" ||
    helper.mode !== "developer-id" ||
    app.teamId !== policy.teamId ||
    helper.teamId !== policy.teamId
  )
    throw new Error(
      "Application and Computer Control helper must share the configured Developer ID team",
    );
  const folder = await mkdtemp(join(tmpdir(), "zcode-notarize-"));
  try {
    const archive = join(folder, "ZCode.zip");
    await runner("/usr/bin/ditto", ["-c", "-k", "--keepParent", appPath, archive]);
    const report = await runner(
      "/usr/bin/xcrun",
      [
        "notarytool",
        "submit",
        archive,
        "--keychain-profile",
        policy.notaryProfile,
        "--wait",
        "--output-format",
        "json",
      ],
      { timeout: 900000 },
    );
    if (JSON.parse(report.stdout).status !== "Accepted")
      throw new Error("macOS notarization was not accepted");
    await runner("/usr/bin/xcrun", ["stapler", "staple", appPath]);
    await runner("/usr/bin/xcrun", ["stapler", "validate", appPath]);
    await runner("/usr/sbin/spctl", ["--assess", "--type", "execute", appPath]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
