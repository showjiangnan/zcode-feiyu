function normalizeToken(raw: string): string {
  return raw.trim().toLowerCase();
}

export function normalizeRemotePlatform(rawPlatform: string): string {
  const platform = normalizeToken(rawPlatform);

  if (platform === "darwin" || platform === "macos") {
    return "darwin";
  }

  if (platform === "linux" || platform === "gnu/linux") {
    return "linux";
  }

  if (
    platform === "windows_nt" ||
    platform.startsWith("mingw") ||
    platform.startsWith("msys") ||
    platform.startsWith("cygwin")
  ) {
    return "win32";
  }

  return platform;
}

export function normalizeRemoteArch(rawArch: string): string {
  const arch = normalizeToken(rawArch);

  if (arch === "x86_64" || arch === "amd64") {
    return "x64";
  }

  if (arch === "aarch64" || arch === "arm64e") {
    return "arm64";
  }

  return arch;
}

export function resolveRemotePlatform(reportedPlatform: string, kernelOstype: string): string {
  const normalizedReportedPlatform = normalizeRemotePlatform(reportedPlatform);
  const normalizedKernelOstype = normalizeRemotePlatform(kernelOstype);

  // 某些 SSH/Docker 测试容器会把 `uname -s` 伪装成 Darwin，
  // 但底层仍是 Linux 内核，直接按 Darwin 选包会上传 Mach-O 并在容器里触发 Exec format error。
  // 这里优先信任 /proc 暴露的真实内核类型，避免把 Linux 容器误判成 macOS。
  if (normalizedReportedPlatform === "darwin" && normalizedKernelOstype === "linux") {
    return "linux";
  }

  return normalizedReportedPlatform;
}
