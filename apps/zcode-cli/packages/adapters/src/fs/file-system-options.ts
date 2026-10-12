// Modified by ZCode Feiyu.
export const DEFAULT_GLOB_MAX_RESULTS = 100;

export interface NodeFileSystemAdapterOptions {
  memoryRootsDirectory?: string;
  memoryHistoryDirectory?: string;
  textSearchEngine?: "ripgrep" | "javascript";
}
