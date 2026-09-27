export interface RemoteAssetNetworkPort {
  fetch: typeof globalThis.fetch;
}

export function resolveRemoteAssetFetch(
  network: RemoteAssetNetworkPort | undefined,
): typeof globalThis.fetch {
  // Desktop Host 的远程资源下载曾直接使用 global fetch，绕过设置页代理。
  // standalone server 没有 Desktop 设置权威，保留未注入时直连的既有合同。
  return network?.fetch ?? globalThis.fetch.bind(globalThis);
}
