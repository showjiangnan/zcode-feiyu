import type { ChromeHelperCookie } from "./chromeLocalStorageManager.js";

const CHROME_EPOCH_OFFSET_MICROSECONDS = 11_644_473_600_000_000n;
const IMPORTED_SESSION_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

export interface ChromeCookieRow {
  host_key: string;
  name: string;
  path: string;
  expires_utc: bigint;
  is_secure: bigint;
  is_httponly: bigint;
  samesite: bigint;
  value: string;
  encrypted_value: Uint8Array;
}

function toCookieExpirationDate(chromeTime: bigint, importedAt: number): number {
  if (chromeTime === 0n) {
    // Electron 的 session Cookie 会随进程退出丢失，导入时按 Chromium 上限持久化。
    return importedAt + IMPORTED_SESSION_COOKIE_MAX_AGE_SECONDS;
  }
  return Number((chromeTime - CHROME_EPOCH_OFFSET_MICROSECONDS) / 1_000_000n);
}

function toSameSite(value: bigint): Electron.CookiesSetDetails["sameSite"] {
  if (value === 0n) return "no_restriction";
  if (value === 1n) return "lax";
  if (value === 2n) return "strict";
  return "unspecified";
}

export function toCookieDetails(
  row: ChromeCookieRow,
  value: string,
  importedAt: number,
): Electron.CookiesSetDetails {
  const host = row.host_key.replace(/^\./, "");
  const secure = row.is_secure === 1n;
  return {
    url: `${secure ? "https" : "http"}://${host}${row.path || "/"}`,
    name: row.name,
    value,
    ...(row.host_key.startsWith(".") ? { domain: row.host_key } : {}),
    path: row.path || "/",
    secure,
    httpOnly: row.is_httponly === 1n,
    sameSite: toSameSite(row.samesite),
    expirationDate: toCookieExpirationDate(row.expires_utc, importedAt),
  };
}

export function toCookieDetailsFromHelper(
  cookie: ChromeHelperCookie,
  importedAt: number,
): Electron.CookiesSetDetails {
  const host = cookie.domain.replace(/^\./, "");
  const sameSite: Electron.CookiesSetDetails["sameSite"] =
    cookie.sameSite === "Strict"
      ? "strict"
      : cookie.sameSite === "Lax"
        ? "lax"
        : cookie.sameSite === "None"
          ? "no_restriction"
          : "unspecified";
  return {
    url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`,
    name: cookie.name,
    value: cookie.value,
    ...(cookie.domain.startsWith(".") ? { domain: cookie.domain } : {}),
    path: cookie.path || "/",
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite,
    expirationDate:
      cookie.session || cookie.expires <= 0
        ? importedAt + IMPORTED_SESSION_COOKIE_MAX_AGE_SECONDS
        : cookie.expires,
  };
}
