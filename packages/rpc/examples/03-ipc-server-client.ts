/**
 * 示例 3: IPCServer + IPCClient —— 多客户端连接管理
 *
 * 演示 VS Code 的真实场景：
 * - 一个 IPCServer (Electron 主进程 / 远端 code-server)
 * - 多个 IPCClient 连接 (多个窗口 / 多个 WebSocket 客户端)
 * - 服务端注册 channel 供客户端调用
 * - 客户端也可以注册 channel 供服务端反向调用
 * - 用 Router 选择目标客户端
 */

import {
  Emitter,
  DisposableStore,
  IChannel,
  IPCServer,
  IPCClient,
  StaticRouter,
  ProxyChannel,
  createQueuePair,
  ClientConnectionEvent,
} from "../src/index.js";

// ============================================================================
// 定义服务
// ============================================================================

/** 服务端提供的全局配置服务 */
class ConfigService {
  private config = new Map<string, any>();
  private readonly _onDidChange = new Emitter<{ key: string; value: any }>();
  readonly onDidChangeConfig = this._onDidChange.event;

  async get(key: string): Promise<any> {
    return this.config.get(key);
  }

  async set(key: string, value: any): Promise<void> {
    this.config.set(key, value);
    this._onDidChange.fire({ key, value });
  }
}

/** 客户端提供的窗口信息服务 */
class WindowInfoService {
  constructor(private windowId: string) {}

  async getTitle(): Promise<string> {
    return `Window ${this.windowId}`;
  }

  async getSize(): Promise<{ width: number; height: number }> {
    return { width: 1920, height: 1080 };
  }
}

// ============================================================================
// 演示
// ============================================================================

async function main() {
  console.log("--- IPCServer + IPCClient Demo ---\n");

  const disposables = new DisposableStore();

  // ========== 创建 IPCServer ==========

  // IPCServer 通过 onDidClientConnect 事件接收新连接
  const serverEmitter = new Emitter<ClientConnectionEvent>();
  const server = new IPCServer<string>(serverEmitter.event);

  // 注册全局配置服务
  const configService = new ConfigService();
  server.registerChannel("config", ProxyChannel.fromService<string>(configService, disposables));

  // ========== 客户端 1 连接 ==========
  console.log('[1] Client "window-1" connecting...');

  const [proto1a, proto1b] = createQueuePair();
  const disconnectEmitter1 = new Emitter<void>();

  // 模拟客户端连接到服务端
  serverEmitter.fire({ protocol: proto1b, onDidClientDisconnect: disconnectEmitter1.event });
  const client1 = new IPCClient(proto1a, "window-1");

  // 客户端注册自己的服务（供服务端反向调用）
  client1.registerChannel(
    "windowInfo",
    ProxyChannel.fromService<string>(new WindowInfoService("window-1"), disposables),
  );

  // ========== 客户端 2 连接 ==========
  console.log('[2] Client "window-2" connecting...');

  const [proto2a, proto2b] = createQueuePair();
  const disconnectEmitter2 = new Emitter<void>();

  serverEmitter.fire({ protocol: proto2b, onDidClientDisconnect: disconnectEmitter2.event });
  const client2 = new IPCClient(proto2a, "window-2");
  client2.registerChannel(
    "windowInfo",
    ProxyChannel.fromService<string>(new WindowInfoService("window-2"), disposables),
  );

  // 等待连接建立
  await new Promise((r) => setTimeout(r, 50));

  // ========== 客户端调用服务端 ==========
  console.log("\n[3] Clients calling server...");

  const remoteConfig1 = ProxyChannel.toService<ConfigService>(client1.getChannel("config"));

  await remoteConfig1.set("theme", "dark");
  console.log(`  client1: set theme = "dark"`);

  const remoteConfig2 = ProxyChannel.toService<ConfigService>(client2.getChannel("config"));

  const theme = await remoteConfig2.get("theme");
  console.log(`  client2: get theme = "${theme}" (读到了 client1 设置的值！)`);

  // ========== 服务端反向调用客户端 ==========
  console.log("\n[4] Server calling clients (reverse IPC)...");

  // 用 StaticRouter 选择 window-1
  const window1Channel = server.getChannel<IChannel>(
    "windowInfo",
    new StaticRouter((ctx) => ctx === "window-1"),
  );
  const window1Info = ProxyChannel.toService<WindowInfoService>(window1Channel);
  const title1 = await window1Info.getTitle();
  console.log(`  server → window-1: title = "${title1}"`);

  // 用 filter 选择 window-2
  const window2Channel = server.getChannel<IChannel>(
    "windowInfo",
    (client) => client.ctx === "window-2",
  );
  const window2Info = ProxyChannel.toService<WindowInfoService>(window2Channel);
  const title2 = await window2Info.getTitle();
  console.log(`  server → window-2: title = "${title2}"`);

  // ========== 显示连接状态 ==========
  console.log(`\n[5] Active connections: ${server.connections.length}`);
  for (const conn of server.connections) {
    console.log(`  - ${conn.ctx}`);
  }

  // ========== 模拟客户端断开 ==========
  console.log('\n[6] Client "window-1" disconnecting...');
  disconnectEmitter1.fire();
  await new Promise((r) => setTimeout(r, 10));

  console.log(`Active connections after disconnect: ${server.connections.length}`);
  for (const conn of server.connections) {
    console.log(`  - ${conn.ctx}`);
  }

  // 清理
  client1.dispose();
  client2.dispose();
  server.dispose();
  disposables.dispose();

  console.log("\nDone!");
}

main().catch(console.error);
