// Modified by ZCode Feiyu.
export type { SqliteMigration } from "./migration-types.js";
import type { SqliteMigration } from "./migration-types.js";
import { BASE_MIGRATIONS } from "./migrations-base.js";
import { INTERACTION_MIGRATIONS } from "./migrations-interaction.js";
import { WORKFLOW_MIGRATIONS } from "./migrations-workflow.js";
import { COORDINATION_MIGRATIONS } from "./migrations-coordination.js";
export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  ...BASE_MIGRATIONS,
  ...INTERACTION_MIGRATIONS,
  ...WORKFLOW_MIGRATIONS,
  ...COORDINATION_MIGRATIONS,
];
