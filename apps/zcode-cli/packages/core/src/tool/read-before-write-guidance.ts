// Modified by ZCode Feiyu.
// 原先只在工具说明要求先读，摘要与并行指导容易掩盖前置条件；系统和子代理共用约束，但不建立另一份读取状态。
export const READ_BEFORE_WRITE_GUIDANCE = [
  "- Before using Edit or overwriting an existing file with Write, use Read on that exact path in this agent's current active context unless you already have valid read state from a successful Read/Edit/Write. Wait for the Read result before deciding and submitting the dependent modification; do not batch that read and write as independent calls.",
  "- Grep/Glob results, quoted code, summaries, and another agent's reads do not establish your read state. For large files, Read a focused offset/limit range covering the edit; a token-truncated view is insufficient.",
  "- A new file does not require a prior Read. Successful Edit/Write updates the read state, so do not re-read just to verify. Re-read after external changes, compaction, or loss of read state on resume.",
  "- On a missing, stale, or token-truncated read-state error, Read the required current content and reconsider the modification using that result. Do not repeat the unchanged failing call or switch to shell writes to bypass the check.",
].join("\n");

export const COMPACT_READ_STATE_RESET_REMINDER =
  "File read state was reset by compaction. Historical file contents and preserved Read/Edit/Write results are reference material, not current read state. Before editing or overwriting an existing file, call Read on its current contents and wait for a successful result that is not token-truncated. A new file needs no prior Read.";

export function formatReadBeforeWriteError(
  filePath: string,
  reason: "not_read" | "partial_read",
): string {
  const target = JSON.stringify(filePath);
  if (reason === "partial_read") {
    return `The last Read of ${target} was truncated by the output token limit. Use Read on this path with a smaller offset/limit range covering the text you intend to change. Wait for an untruncated result, then reconsider the modification using that content.`;
  }
  return `File has not been read in the current active context: ${target}. Call Read on this path and wait for a successful result before retrying the modification. Search results, quoted text, and summaries do not establish read state.`;
}
