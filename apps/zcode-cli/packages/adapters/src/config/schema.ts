// Modified by ZCode Feiyu.
export {
  CANONICAL_CUA_PLUGIN_ID,
  LEGACY_CUA_PLUGIN_ID,
  ZCodeConfigFileSchema,
  canonicalizePluginId,
  hookCommandSchema,
  hookMatcherSchema,
  hookProcessSchema,
  hooksSchema,
  pluginIdAliases,
  type ZCodeConfigFile,
} from "./schema-definitions.js";
export {
  parseConfigFileToRuntimePatchWithDiagnostics,
  type ConfigDiagnostic,
  type ConfigDiagnosticCode,
  type ConfigDiagnosticSeverity,
  type ParseConfigFileResult,
} from "./schema-normalization.js";
