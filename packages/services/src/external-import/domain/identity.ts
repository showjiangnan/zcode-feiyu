// Modified by ZCode Feiyu.
/** 文件系统已 canonicalize 后的身份字符串；Windows 大小写及分隔符不得产生重复导入。 */
export function importPathIdentity(path: string, platform: string): string {
  return platform === "win32" ? path.replace(/\\/gu, "/").toLowerCase() : path;
}
