// Modified by ZCode Feiyu.
export {
  loadFileConfig,
  resolvePath,
  type LoadedConfig,
  type PluginEnabledPatchResult,
  type PluginOptionsPatchResult,
  type PluginRemovePatchResult,
  type UiLocalePatchResult,
} from "./file-config-loader.js";
export {
  addSuppressedBuiltinInFileConfig,
  enablePluginsByDefaultInFileConfig,
  getDefaultConfigPath,
  hasDefaultConfigFile,
  removePluginEnabledFromFileConfig,
  removePluginFromFileConfig,
  removeSuppressedBuiltinInFileConfig,
  updatePluginEnabledInFileConfig,
  updatePluginOptionsInFileConfig,
  updateUiLocaleInFileConfig,
  type SuppressedBuiltinPatchResult,
} from "./file-config-mutations.js";
