// Modified by ZCode Feiyu.
import type { ConfigResult } from "@zcode/adapters/config";
import type { AgentRuntimeConfig } from "@zcode/core";

import { createNodeSkillAdapter } from "@zcode/adapters/skills";
import { type SkillRoot } from "@zcode/contracts";

import { join } from "node:path";

import { collectDisabledPaths } from "../skill-command-overrides.js";

import { collectDynamicWorkflowDisabledSkillPaths } from "./dynamic-workflow-gate.js";

import type { ZCodeAppOptions } from "./types.js";

// 装配阶段复用同一实例与闭包，不另建运行状态或副作用路径。
export function createAppSkillFactory(input: {
  configResult: ConfigResult;
  options: ZCodeAppOptions;
  bundledSkillRoots: SkillRoot[];
  runtimeConfig: AgentRuntimeConfig;
}) {
  const { configResult, options, bundledSkillRoots, runtimeConfig } = input;

  const createSessionSkillPort = (roots: SkillRoot[]) =>
    configResult.config.features.skill && configResult.config.skills.enabled
      ? (options.skillPort ??
        createNodeSkillAdapter({
          extraRoots: configResult.config.skills.roots,
          extraResolvedRoots: [...roots, ...bundledSkillRoots],
          disabledPaths: [
            ...collectDisabledPaths(configResult.config.skillOverrides),
            ...(!options.imageGenerationPort?.config.enabled
              ? bundledSkillRoots.map((root) => join(root.path, "image-generation", "SKILL.md"))
              : []),
            ...(runtimeConfig.dynamicWorkflowEnabled === false
              ? collectDynamicWorkflowDisabledSkillPaths(bundledSkillRoots)
              : []),
          ],
        }))
      : undefined;
  return { createSessionSkillPort };
}
