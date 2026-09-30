// Modified by ZCode Feiyu contributors (2026).
import type { SessionId, SubagentPort, TeamBoardPort, TraceContext } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "./internal.js";

const MAX_TEAM_MESSAGE_CHARS = 4_000;

type TeamParent = Pick<
  AgentRuntimeInternal,
  | "sessionId"
  | "branchGeneration"
  | "orchestration"
  | "runtimeTaskRegistry"
  | "subagentPort"
  | "teamBoardPort"
>;

/** child 只获得绑定出生身份的父端口，不能用旧运行的 actorId 冒用同名新运行。 */
export function createTeamMemberPorts(
  parent: TeamParent,
  member: {
    agentId: string;
    teamMemberName: string;
    sessionId: SessionId;
    traceContext: TraceContext;
  },
): { subagentPort: SubagentPort; teamBoardPort?: TeamBoardPort; teamActorId: string } {
  const branchGeneration = member.traceContext.attributes?.branchGeneration;
  const runId = member.traceContext.parentSpanId;
  const isCurrent = (): boolean => {
    const task = parent.runtimeTaskRegistry.get(member.agentId);
    return Boolean(
      task &&
      task.type === "local_agent" &&
      task.status === "running" &&
      task.parentSessionId === parent.sessionId &&
      task.childSessionId === member.sessionId &&
      task.teamMemberName === member.teamMemberName &&
      task.branchGeneration === branchGeneration &&
      branchGeneration === parent.branchGeneration &&
      runId &&
      task.traceContext?.spanId === runId,
    );
  };
  const unavailable = async (): Promise<never> => {
    throw new Error("Team members cannot launch nested agents");
  };
  return {
    teamActorId: member.agentId,
    ...(parent.teamBoardPort
      ? {
          teamBoardPort: {
            execute: (input) => {
              if (!isCurrent())
                return Promise.reject(new Error("The team member run is stopped or superseded"));
              return parent.teamBoardPort!.execute(input, member.agentId);
            },
          },
        }
      : {}),
    subagentPort: {
      launch: unavailable,
      run: unavailable,
      sendMessage: async (request, options) => {
        const candidate =
          parent.runtimeTaskRegistry.get(request.to) ??
          Object.values(parent.runtimeTaskRegistry.all()).find(
            (task) =>
              task.type === "local_agent" &&
              task.parentSessionId === parent.sessionId &&
              task.branchGeneration === branchGeneration &&
              task.teamMemberName?.normalize("NFKC").toLowerCase() ===
                request.to.normalize("NFKC").toLowerCase(),
          );
        // 只校验收件人会让撤回前的 child 向新团队发消息；发送端也必须仍持有原运行。
        if (
          !isCurrent() ||
          parent.orchestration.effective !== "swarm" ||
          candidate?.type !== "local_agent" ||
          !candidate.teamMemberName ||
          candidate.parentSessionId !== parent.sessionId ||
          candidate.branchGeneration !== branchGeneration ||
          request.message.length > MAX_TEAM_MESSAGE_CHARS
        ) {
          return {
            status: "failed",
            messageId: request.messageId ?? `msg_${crypto.randomUUID()}`,
            agentId: request.to,
            error: "The member run or swarm message capability is unavailable",
          };
        }
        const send = parent.subagentPort?.sendMessage;
        if (!send) throw new Error("Team message delivery is unavailable");
        return send(
          {
            ...request,
            sessionId: parent.sessionId,
            to: candidate.agentId,
            senderAgentId: member.agentId,
            senderName: member.teamMemberName,
          },
          options,
        );
      },
    },
  };
}
