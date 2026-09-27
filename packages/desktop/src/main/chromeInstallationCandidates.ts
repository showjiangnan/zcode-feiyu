import { homedir } from "node:os";
import { join } from "node:path";

const USER_DATA_ARGUMENT_PATTERN = /--user-data-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;
const PASSWORD_STORE_ARGUMENT_PATTERN =
  /--password-store(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/i;

export type LinuxChromePasswordStore =
  | "basic"
  | "gnome-libsecret"
  | "kwallet"
  | "kwallet5"
  | "kwallet6";

const LINUX_CHROME_PASSWORD_STORES = new Set<LinuxChromePasswordStore>([
  "basic",
  "gnome-libsecret",
  "kwallet",
  "kwallet5",
  "kwallet6",
]);

export type ChromeBrowserKind =
  | "chrome"
  | "chrome-beta"
  | "chrome-dev"
  | "chrome-canary"
  | "chrome-for-testing"
  | "chromium";

export interface ChromeInstallationCandidate {
  browser: ChromeBrowserKind;
  userDataDir: string;
  executablePaths: string[];
  executablePath?: string;
  passwordStore?: LinuxChromePasswordStore;
}

export interface ChromeInstallationPathOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  localAppData?: string;
  platform?: NodeJS.Platform;
  programFiles?: string;
  programFilesX86?: string;
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const normalized = path?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function windowsProductPath(browser: ChromeBrowserKind): string[] {
  switch (browser) {
    case "chrome":
      return ["Google", "Chrome"];
    case "chrome-beta":
      return ["Google", "Chrome Beta"];
    case "chrome-dev":
      return ["Google", "Chrome Dev"];
    case "chrome-canary":
      return ["Google", "Chrome SxS"];
    case "chrome-for-testing":
      return ["Google", "Chrome for Testing"];
    case "chromium":
      return ["Chromium"];
  }
}

function macProductDirectory(browser: ChromeBrowserKind): string {
  switch (browser) {
    case "chrome":
      return "Chrome";
    case "chrome-beta":
      return "Chrome Beta";
    case "chrome-dev":
      return "Chrome Dev";
    case "chrome-canary":
      return "Chrome Canary";
    case "chrome-for-testing":
      return "Chrome for Testing";
    case "chromium":
      return "Chromium";
  }
}

function macApplicationName(browser: ChromeBrowserKind): string {
  switch (browser) {
    case "chrome":
      return "Google Chrome";
    case "chrome-beta":
      return "Google Chrome Beta";
    case "chrome-dev":
      return "Google Chrome Dev";
    case "chrome-canary":
      return "Google Chrome Canary";
    case "chrome-for-testing":
      return "Google Chrome for Testing";
    case "chromium":
      return "Chromium";
  }
}

function linuxProductDirectory(browser: ChromeBrowserKind): string {
  switch (browser) {
    case "chrome":
      return "google-chrome";
    case "chrome-beta":
      return "google-chrome-beta";
    case "chrome-dev":
      return "google-chrome-unstable";
    case "chrome-canary":
      return "google-chrome-canary";
    case "chrome-for-testing":
      return "google-chrome-for-testing";
    case "chromium":
      return "chromium";
  }
}

function linuxExecutablePaths(browser: ChromeBrowserKind): string[] {
  switch (browser) {
    case "chrome":
      return [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/opt/google/chrome/google-chrome",
        "/opt/google/chrome/chrome",
      ];
    case "chrome-beta":
      return [
        "/usr/bin/google-chrome-beta",
        "/opt/google/chrome-beta/google-chrome-beta",
        "/opt/google/chrome-beta/chrome",
      ];
    case "chrome-dev":
      return [
        "/usr/bin/google-chrome-unstable",
        "/opt/google/chrome-unstable/google-chrome-unstable",
        "/opt/google/chrome-unstable/chrome",
      ];
    case "chrome-canary":
      return ["/usr/bin/google-chrome-canary"];
    case "chrome-for-testing":
      return ["/usr/bin/google-chrome-for-testing"];
    case "chromium":
      return [
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/lib/chromium/chromium",
        "/usr/lib/chromium-browser/chromium-browser",
      ];
  }
}

export function buildStandardChromeInstallations(
  options: ChromeInstallationPathOptions = {},
): ChromeInstallationCandidate[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const browsers: ChromeBrowserKind[] = [
    "chrome",
    "chrome-beta",
    "chrome-dev",
    "chrome-canary",
    "chrome-for-testing",
    "chromium",
  ];

  if (platform === "darwin") {
    return browsers.map((browser) => {
      const productDirectory = macProductDirectory(browser);
      const applicationName = macApplicationName(browser);
      const supportRoot =
        browser === "chromium"
          ? join(homeDir, "Library", "Application Support")
          : join(homeDir, "Library", "Application Support", "Google");
      return {
        browser,
        userDataDir: join(supportRoot, productDirectory),
        executablePaths: [
          join("/Applications", `${applicationName}.app`, "Contents", "MacOS", applicationName),
          join(
            homeDir,
            "Applications",
            `${applicationName}.app`,
            "Contents",
            "MacOS",
            applicationName,
          ),
        ],
      };
    });
  }

  if (platform === "win32") {
    const localAppData =
      options.localAppData ?? env.LOCALAPPDATA ?? join(homeDir, "AppData", "Local");
    const programRoots = uniquePaths([
      options.programFiles ?? env.PROGRAMFILES ?? "C:\\Program Files",
      options.programFilesX86 ?? env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
      localAppData,
    ]);
    return browsers.map((browser) => {
      const productPath = windowsProductPath(browser);
      return {
        browser,
        userDataDir: join(localAppData, ...productPath, "User Data"),
        executablePaths: programRoots.map((root) =>
          join(root, ...productPath, "Application", "chrome.exe"),
        ),
      };
    });
  }

  const configRoot = env.CHROME_CONFIG_HOME ?? env.XDG_CONFIG_HOME ?? join(homeDir, ".config");
  const standardInstallations = browsers.map((browser) => ({
    browser,
    userDataDir: join(configRoot, linuxProductDirectory(browser)),
    executablePaths: linuxExecutablePaths(browser),
  }));
  // Ubuntu 上 Chromium 常以 Snap 安装，Chrome/Chromium 也可能来自 Flatpak。
  // 这些 Profile 不在 XDG 标准目录中；保留独立候选，才能在标准目录为空时继续发现真实数据。
  const sandboxedInstallations: ChromeInstallationCandidate[] = [
    {
      browser: "chromium",
      userDataDir: join(homeDir, "snap", "chromium", "common", "chromium"),
      executablePaths: ["/snap/bin/chromium", "/var/lib/snapd/snap/bin/chromium"],
    },
    {
      browser: "chrome",
      userDataDir: join(homeDir, ".var", "app", "com.google.Chrome", "config", "google-chrome"),
      executablePaths: [
        join(homeDir, ".local", "share", "flatpak", "exports", "bin", "com.google.Chrome"),
        "/var/lib/flatpak/exports/bin/com.google.Chrome",
      ],
    },
    {
      browser: "chromium",
      userDataDir: join(homeDir, ".var", "app", "org.chromium.Chromium", "config", "chromium"),
      executablePaths: [
        join(homeDir, ".local", "share", "flatpak", "exports", "bin", "org.chromium.Chromium"),
        "/var/lib/flatpak/exports/bin/org.chromium.Chromium",
      ],
    },
  ];
  return [...standardInstallations, ...sandboxedInstallations];
}

function parseExecutablePath(commandLine: string): string | undefined {
  const quoted = commandLine.match(/^\s*"([^"]+(?:chrome|chromium)[^"]*)"/i)?.[1];
  if (quoted) return quoted;
  const macApplication = commandLine.match(
    /^\s*(.+?\/(?:Google Chrome(?: Beta| Dev| Canary| for Testing)?|Chromium))(?:\s+--|$)/i,
  )?.[1];
  if (macApplication) return macApplication;
  return commandLine.match(/^\s*(\S*(?:chrome|chromium)(?:\.exe)?)(?:\s|$)/i)?.[1];
}

export function isChromeBrowserExecutable(path: string): boolean {
  const executableName = path.replaceAll("\\", "/").split("/").at(-1) ?? path;
  return /^(?:chrome(?:\.exe)?|chromium|chromium-browser|google-chrome(?:-stable|-beta|-unstable|-canary|-for-testing)?|Google Chrome(?: Beta| Dev| Canary| for Testing)?|com\.google\.Chrome|org\.chromium\.Chromium)$/i.test(
    executableName,
  );
}

export function parseRunningChromeExecutablePaths(commandLines: string[]): string[] {
  const executablePaths: string[] = [];
  const seen = new Set<string>();
  for (const commandLine of commandLines) {
    const executablePath = parseExecutablePath(commandLine);
    if (!executablePath || !isChromeBrowserExecutable(executablePath)) continue;
    const normalized = executablePath.replaceAll("\\", "/").toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    executablePaths.push(executablePath);
  }
  return executablePaths;
}

function parseLinuxChromePasswordStore(commandLine: string): LinuxChromePasswordStore | undefined {
  const match = commandLine.match(PASSWORD_STORE_ARGUMENT_PATTERN);
  const value = (match?.[1] ?? match?.[2] ?? match?.[3])?.toLowerCase();
  return value && LINUX_CHROME_PASSWORD_STORES.has(value as LinuxChromePasswordStore)
    ? (value as LinuxChromePasswordStore)
    : undefined;
}

function pathsMatch(left: string, right: string): boolean {
  return left.replaceAll("\\", "/").toLowerCase() === right.replaceAll("\\", "/").toLowerCase();
}

function isChromeMainProcessCommandLine(commandLine: string): boolean {
  return !/(?:^|\s)--type(?:=|\s)/i.test(commandLine);
}

export function parseRunningChromeInstallations(
  commandLines: string[],
  fallbackInstallations: ChromeInstallationCandidate[] = [],
): ChromeInstallationCandidate[] {
  const installations: ChromeInstallationCandidate[] = [];
  for (const commandLine of commandLines) {
    const executablePath = parseExecutablePath(commandLine);
    if (!executablePath || !isChromeBrowserExecutable(executablePath)) continue;
    const passwordStore = parseLinuxChromePasswordStore(commandLine);
    let userDataDirFound = false;
    USER_DATA_ARGUMENT_PATTERN.lastIndex = 0;
    for (const match of commandLine.matchAll(USER_DATA_ARGUMENT_PATTERN)) {
      const userDataDir = match[1] ?? match[2] ?? match[3];
      if (!userDataDir) continue;
      userDataDirFound = true;
      installations.push({
        browser: /chromium/i.test(commandLine) ? "chromium" : "chrome",
        userDataDir,
        executablePaths: [executablePath],
        executablePath,
        ...(passwordStore ? { passwordStore } : {}),
      });
    }
    if (userDataDirFound || !isChromeMainProcessCommandLine(commandLine)) continue;
    const fallback = fallbackInstallations.find((candidate) =>
      candidate.executablePaths.some((path) => pathsMatch(path, executablePath)),
    );
    if (fallback) {
      // Linux 常规启动不会显式携带 --user-data-dir；仍需把运行进程选择的密钥后端
      // 合并回对应标准 Profile，确保隔离 helper 使用同一个 Libsecret/KWallet backend。
      installations.push({
        ...fallback,
        executablePath,
        ...(passwordStore ? { passwordStore } : {}),
      });
    }
  }
  return installations;
}
