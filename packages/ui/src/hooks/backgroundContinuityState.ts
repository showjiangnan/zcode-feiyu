// Modified by ZCode Feiyu contributors (2026).
import type { BackgroundContinuityStatus } from "@zcode/shared";

/**
 * 后台运行状态行的拥有状态。读取错误与停止错误分开保存：
 * 读取错误在下一次成功读取后清除；停止错误保留到下一次停止开始或成功（复审 DEF-23）。
 */
export interface OwnedBackgroundContinuity<Platform> {
  platform: Platform;
  status: BackgroundContinuityStatus | null;
  readError: string | null;
  stopError: string | null;
}

export function initialBackgroundContinuity<Platform>(
  platform: Platform,
): OwnedBackgroundContinuity<Platform> {
  return { platform, status: null, readError: null, stopError: null };
}

export function backgroundReadSucceeded<Platform>(
  previous: OwnedBackgroundContinuity<Platform>,
  platform: Platform,
  status: BackgroundContinuityStatus,
): OwnedBackgroundContinuity<Platform> {
  return {
    platform,
    status,
    readError: null,
    stopError: previous.platform === platform ? previous.stopError : null,
  };
}

export function backgroundReadFailed<Platform>(
  previous: OwnedBackgroundContinuity<Platform>,
  message: string,
): OwnedBackgroundContinuity<Platform> {
  return { ...previous, readError: message };
}

export function backgroundStopStarted<Platform>(
  previous: OwnedBackgroundContinuity<Platform>,
): OwnedBackgroundContinuity<Platform> {
  return { ...previous, stopError: null };
}

export function backgroundStopSucceeded<Platform>(
  platform: Platform,
  status: BackgroundContinuityStatus,
): OwnedBackgroundContinuity<Platform> {
  return { platform, status, readError: null, stopError: null };
}

export function backgroundStopFailed<Platform>(
  previous: OwnedBackgroundContinuity<Platform>,
  message: string,
): OwnedBackgroundContinuity<Platform> {
  return { ...previous, stopError: message };
}

/** 展示用错误：停止失败比读取失败更需要用户处理，两者同时存在时先显示停止错误。 */
export function visibleBackgroundError<Platform>(
  owned: OwnedBackgroundContinuity<Platform>,
  platform: Platform,
): string | null {
  return owned.platform === platform ? (owned.stopError ?? owned.readError) : null;
}
