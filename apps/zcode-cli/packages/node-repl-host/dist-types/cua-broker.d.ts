import type { ComputerUseRuntime } from "@zcode/zcode-cua";
import type { NodeReplRunResult } from "@zcode/core/repl";
import type { Logger } from "@zcode/contracts";
import { type NodeReplCuaBrokerConnection } from "./cua-bridge.js";
export interface NodeReplCuaBroker {
    connection: NodeReplCuaBrokerConnection;
    admit(meta: Record<string, unknown>): {
        connection: NodeReplCuaBrokerConnection;
        release(): void;
        project(run: NodeReplRunResult): NodeReplRunResult;
    } | undefined;
    ready: Promise<void>;
    close(): Promise<void>;
}
export declare function createNodeReplCuaBroker(input: {
    runtime: ComputerUseRuntime;
    logger?: Logger;
    platform?: NodeJS.Platform | string;
}): NodeReplCuaBroker;
//# sourceMappingURL=cua-broker.d.ts.map