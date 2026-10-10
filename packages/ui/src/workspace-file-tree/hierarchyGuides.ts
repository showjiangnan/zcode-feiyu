// Modified by ZCode Feiyu contributors (2026).
import type { CSSProperties } from "react";

const WORKSPACE_FILE_TREE_HIERARCHY_GUIDE_BACKGROUND =
  "repeating-linear-gradient(to right, transparent 0 calc(0.5rem - 1px), var(--color-border) calc(0.5rem - 1px) 0.5rem, transparent 0.5rem 1.375rem)";

export function getWorkspaceFileTreeHierarchyGuideStyle(depth: number): CSSProperties | null {
  if (depth <= 0) {
    return null;
  }

  return {
    width: `calc(${depth} * 1.375rem)`,
    backgroundImage: WORKSPACE_FILE_TREE_HIERARCHY_GUIDE_BACKGROUND,
  };
}
