// Modified by ZCode Feiyu.
import { createRuntime } from "./src/app/runtime.js";
import { request } from "./src/adapters/ipc-client.js";
export function createComputerUseRuntime(options = {}) {
  return createRuntime({ env: process.env, ...options, request });
}
