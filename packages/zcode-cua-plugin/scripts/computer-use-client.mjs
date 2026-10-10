// Modified by ZCode Feiyu contributors (2026).
/** Legacy bootstrap helper; pass the active REPL global explicitly. */
export function createComputerUseClient(runtimeGlobal) {
  const client = runtimeGlobal?.cua;
  if (!client || typeof client.initialize !== "function")
    throw new Error("Computer Control requires the active ZCode Node REPL");
  return client;
}
