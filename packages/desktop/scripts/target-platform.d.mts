export type TargetPlatformOs = "darwin" | "win32" | "linux";
export type TargetPlatformArch = "x64" | "arm64";

export interface TargetPlatform {
  os: TargetPlatformOs;
  arch: TargetPlatformArch;
  key: string;
  npmOs: TargetPlatformOs;
  npmCpu: TargetPlatformArch;
  npmLibc?: "glibc";
}

export function getTargetPlatform(): TargetPlatform;
export function resolvePlatformKeyForPackagedApp(): string;
