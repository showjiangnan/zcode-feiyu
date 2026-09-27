/**
 * 示例 2: ProxyChannel —— 零样板代码的服务代理
 *
 * 对比示例 1 中手写的 CalculatorChannel，这里用 ProxyChannel
 * 一行代码就能把 service 暴露为 channel，再一行恢复为 service。
 *
 * 这就是 VS Code 里几百个 service 能轻松跨进程通信的秘密。
 */

import {
  Emitter,
  Event,
  DisposableStore,
  ChannelServer,
  ChannelClient,
  ProxyChannel,
  createQueuePair,
} from "../src/index.js";

// ============================================================================
// 定义 service 接口和实现
// ============================================================================

/** 文件系统服务接口 */
interface IFileService {
  onDidChangeFile: Event<{ path: string; type: string }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listFiles(dir: string): Promise<string[]>;
}

/** 模拟的文件系统实现 */
class InMemoryFileService implements IFileService {
  private files = new Map<string, string>();
  private readonly _onDidChangeFile = new Emitter<{ path: string; type: string }>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`File not found: ${path}`);
    }
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const isNew = !this.files.has(path);
    this.files.set(path, content);
    this._onDidChangeFile.fire({
      path,
      type: isNew ? "created" : "changed",
    });
  }

  async listFiles(dir: string): Promise<string[]> {
    return [...this.files.keys()].filter((p) => p.startsWith(dir));
  }
}

// ============================================================================
// 演示 ProxyChannel
// ============================================================================

async function main() {
  const [protocolA, protocolB] = createQueuePair();
  const disposables = new DisposableStore();

  // ========== 服务端 ==========
  const fileService = new InMemoryFileService();

  // 一行代码：把 service 变成 channel！
  // ProxyChannel.fromService 会自动：
  // - 把 readFile, writeFile, listFiles 映射为 call
  // - 把 onDidChangeFile 映射为 listen
  const channel = ProxyChannel.fromService<string>(fileService, disposables);

  const server = new ChannelServer(protocolB, "server");
  server.registerChannel("fileService", channel);

  // ========== 客户端 ==========
  const client = new ChannelClient(protocolA);
  await Event.toPromise(client.onDidInitialize);

  // 一行代码：把 channel 恢复为类型安全的 service！
  // 利用 ES6 Proxy，调用 remoteFS.readFile(...) 会自动变成 channel.call('readFile', [...])
  const remoteFS = ProxyChannel.toService<IFileService>(client.getChannel("fileService"));

  // ========== 使用远程服务（就像调本地方法一样！）==========
  console.log("--- ProxyChannel Demo ---");
  console.log("（注意：所有调用都经过了序列化 → 传输 → 反序列化）\n");

  // 监听文件变更事件
  const eventDisposable = remoteFS.onDidChangeFile((e) => {
    console.log(`  [file event] ${e.type}: ${e.path}`);
  });

  // 写入文件
  await remoteFS.writeFile("/src/main.ts", 'console.log("hello")');
  await remoteFS.writeFile("/src/util.ts", "export function add(a, b) { return a + b; }");
  await remoteFS.writeFile("/src/main.ts", 'console.log("hello world")'); // 修改

  // 读取文件
  const content = await remoteFS.readFile("/src/main.ts");
  console.log(`\nreadFile('/src/main.ts') = "${content}"`);

  // 列出文件
  const files = await remoteFS.listFiles("/src");
  console.log(`listFiles('/src') = ${JSON.stringify(files)}`);

  // 测试错误传播
  try {
    await remoteFS.readFile("/nonexistent");
  } catch (err: any) {
    console.log(`readFile('/nonexistent') → Error: ${err.message}`);
  }

  // 清理
  eventDisposable.dispose();
  client.dispose();
  server.dispose();
  disposables.dispose();

  console.log("\nDone!");
}

main().catch(console.error);
