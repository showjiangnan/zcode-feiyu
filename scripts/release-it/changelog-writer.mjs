import createConventionalCommitsPreset from "conventional-changelog-conventionalcommits";

export const RELEASE_CHANGELOG_TYPES = [
  { type: "feat", section: "Features" },
  { type: "fix", section: "Bug Fixes" },
  { type: "chore", section: "Chores" },
  { type: "docs", section: "Documentation" },
  { type: "refactor", section: "Refactorings" },
  { type: "", section: "Other Changes" },
];

export const RELEASE_CHANGELOG_PARSER_OPTS = {
  headerPattern: /^(?:(\w+)(?:\(([^)]*)\))?:\s+)?(.+)$/,
  breakingHeaderPattern: /^(\w+)(?:\(([^)]*)\))?!:\s+(.+)$/,
  headerCorrespondence: ["type", "scope", "subject"],
};

export function extractCommitBodyBullets(body) {
  if (typeof body !== "string" || body.trim() === "") {
    return [];
  }

  return body
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*[-*+]\s+(.+?)\s*$/)?.[1]?.trim())
    .filter((item) => item && !/^BREAKING[ -]CHANGE:/i.test(item));
}

export function createReleaseChangelogWriterOpts() {
  const preset = createConventionalCommitsPreset({
    types: RELEASE_CHANGELOG_TYPES,
  });
  const baseWriter = preset.writer;
  const baseTransform = baseWriter.transform;

  return {
    ...baseWriter,
    commitPartial: `*{{#if scope}} **{{scope}}:**{{/if}} {{#if subject}}{{subject}}{{else}}{{header}}{{/if}}{{#if hash}} {{#if @root.linkReferences}}([{{shortHash}}]({{@root.host}}/{{@root.owner}}/{{@root.repository}}/commit/{{hash}})){{else}}{{shortHash}}{{/if}}{{/if}}{{#if references}}, closes{{#each references}} {{#if @root.linkReferences}}[{{#if this.owner}}{{this.owner}}/{{/if}}{{this.repository}}{{this.prefix}}{{this.issue}}]({{issueUrlFormat}}){{else}}{{#if this.owner}}{{this.owner}}/{{/if}}{{this.repository}}{{this.prefix}}{{this.issue}}{{/if}}{{/each}}{{/if}}
{{#if bodyBullets}}{{#each bodyBullets}}  * {{this}}
{{/each}}{{/if}}
`,
    transform(commit, context) {
      const transformed = baseTransform(commit, context);
      if (!transformed) {
        return transformed;
      }

      const bodyBullets = extractCommitBodyBullets(commit.body);
      if (bodyBullets.length === 0) {
        return transformed;
      }

      return {
        ...transformed,
        bodyBullets,
      };
    },
  };
}
