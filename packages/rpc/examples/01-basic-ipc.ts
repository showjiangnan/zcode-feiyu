/**
 * 示例 1: 基础 IPC —— 通过内存 Queue 演示完整的 RPC 调用
 *
 * 演示了最核心的流程：
 * 1. 创建内存传输对 (QueueProtocol)
 * 2. 在服务端注册一个 channel
 * 3. 客户端获取 channel 并调用方法 / 监听事件
 *
 * 数据流：
 *   client.call('add', [1, 2])
 *       ↓ serialize → send
 *   [protocol A] ──buffer──→ [protocol B]
 *       ↓ deserialize → dispatch
 *   channel.call(ctx, 'add', [1, 2])
 *       ↓ return 3
 *   [protocol B] ──buffer──→ [protocol A]
 *       ↓ deserialize → resolve promise
 *   result = 3
 */

import {
  Emitter,
  Event,
  IServerChannel,
  ChannelServer,
  ChannelClient,
  createQueuePair,
} from "../src/index.js";

// ============================================================================
// Step 1: 定义一个 service（普通 TypeScript 对象）
// ============================================================================

class CalculatorService {
  private readonly _onDidCompute = new Emitter<{ op: string; result: number }>();
  readonly onDidCompute = this._onDidCompute.event;

  add(a: number, b: number): number {
    const result = a + b;
    this._onDidCompute.fire({ op: `${a} + ${b}`, result });
    return result;
  }

  multiply(a: number, b: number): number {
    const result = a * b;
    this._onDidCompute.fire({ op: `${a} * ${b}`, result });
    return result;
  }

  async divide(a: number, b: number): Promise<number> {
    if (b === 0) {
      throw new Error("Division by zero");
    }
    const result = a / b;
    this._onDidCompute.fire({ op: `${a} / ${b}`, result });
    return result;
  }
}

// ============================================================================
// Step 2: 手写 IServerChannel（后面的例子会用 ProxyChannel 自动化）
// ============================================================================

class CalculatorChannel implements IServerChannel {
  constructor(private service: CalculatorService) {}

  call(_ctx: string, command: string, arg?: any): Promise<any> {
    switch (command) {
      case "add":
        return Promise.resolve(this.service.add(arg[0], arg[1]));
      case "multiply":
        return Promise.resolve(this.service.multiply(arg[0], arg[1]));
      case "divide":
        return this.service.divide(arg[0], arg[1]);
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  listen(_ctx: string, event: string): Event<any> {
    switch (event) {
      case "onDidCompute":
        return this.service.onDidCompute;
      default:
        throw new Error(`Unknown event: ${event}`);
    }
  }
}

// ============================================================================
// Step 3: 建立连接并进行 RPC
// ============================================================================

async function main() {
  // 创建内存传输对
  const [protocolA, protocolB] = createQueuePair();

  // 服务端：在 protocolB 上注册 channel
  const service = new CalculatorService();
  const server = new ChannelServer(protocolB, "server-ctx");
  server.registerChannel("calculator", new CalculatorChannel(service));

  // 客户端：通过 protocolA 获取 channel
  const client = new ChannelClient(protocolA);

  // 等待初始化完成
  await Event.toPromise(client.onDidInitialize);

  const calculator = client.getChannel("calculator");

  // 订阅事件
  const disposable = calculator.listen<{ op: string; result: number }>("onDidCompute")((e) => {
    console.log(`  [event] ${e.op} = ${e.result}`);
  });

  // 调用方法
  console.log("--- Basic IPC Demo ---");

  const sum = await calculator.call<number>("add", [10, 20]);
  console.log(`add(10, 20) = ${sum}`);

  const product = await calculator.call<number>("multiply", [6, 7]);
  console.log(`multiply(6, 7) = ${product}`);

  const quotient = await calculator.call<number>("divide", [100, 3]);
  console.log(`divide(100, 3) = ${quotient}`);

  // 测试错误传播
  try {
    await calculator.call("divide", [1, 0]);
  } catch (err: any) {
    console.log(`divide(1, 0) → Error: ${err.message}`);
  }

  // 清理
  disposable.dispose();
  client.dispose();
  server.dispose();

  console.log("\nDone!");
}

main().catch(console.error);
