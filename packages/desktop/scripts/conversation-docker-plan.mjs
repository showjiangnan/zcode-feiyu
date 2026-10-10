// Modified by ZCode Feiyu contributors (2026).
export const VERIFIED_DOCKER_TABLE_END_MARKER = "<!-- conversation-session-verified-table-end -->";

export function insertVerifiedDockerSpecRow(text, specRelFromDesktop) {
  const row = `| \`${specRelFromDesktop}\` | verified |`;
  if (text.includes(row) || text.includes(`| \`${specRelFromDesktop}\` |`)) {
    return { inserted: false, text };
  }
  if (!text.includes(VERIFIED_DOCKER_TABLE_END_MARKER)) {
    return {
      error: "Cannot find Docker suite table end marker",
      inserted: false,
      text,
    };
  }

  return {
    inserted: true,
    text: text.replace(
      VERIFIED_DOCKER_TABLE_END_MARKER,
      `${row}\n${VERIFIED_DOCKER_TABLE_END_MARKER}`,
    ),
  };
}
