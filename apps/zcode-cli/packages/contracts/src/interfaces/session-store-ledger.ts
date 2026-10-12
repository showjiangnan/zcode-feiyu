// Modified by ZCode Feiyu.
import type { SessionId, MessageId } from "./shared.js";

export const SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION =
  "target_completion_verification" as const;

export const SESSION_ENTRY_BASH_SHELL_SELECTION = "runtime/bash_shell_selection" as const;

export const SESSION_ENTRY_MODEL_SELECTION = "runtime/model_selection" as const;

export const SESSION_ENTRY_EXECUTION_STATE = "runtime/execution_state" as const;

export const SESSION_ENTRY_ORCHESTRATION_STATE = "runtime/orchestration_state" as const;

export const SESSION_ENTRY_TEAM_BOARD = "runtime/team_board" as const;

export const SESSION_ENTRY_TEAM_MESSAGE = "runtime/team_message" as const;

export const SESSION_ENTRY_TEAM_MEMBER = "runtime/team_member" as const;

export const SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION =
  "runtime/user_input_auto_resolution" as const;

export const SESSION_ENTRY_WORKSPACE_CHECKPOINT = "runtime/workspace_checkpoint" as const;

export const SESSION_ENTRY_WORKSPACE_FILE_REWIND = "runtime/workspace_file_rewind" as const;

/** 动态工作流工具面已在本会话激活（docs/dynamic-workflow/launch.md「On demand: activation」）。 */
export const SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION =
  "runtime/dynamic_workflow_activation" as const;

export const SESSION_ENTRY_TYPES = [
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  SESSION_ENTRY_BASH_SHELL_SELECTION,
  SESSION_ENTRY_MODEL_SELECTION,
  SESSION_ENTRY_EXECUTION_STATE,
  SESSION_ENTRY_ORCHESTRATION_STATE,
  SESSION_ENTRY_TEAM_BOARD,
  SESSION_ENTRY_TEAM_MESSAGE,
  SESSION_ENTRY_TEAM_MEMBER,
  SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION,
  SESSION_ENTRY_WORKSPACE_CHECKPOINT,
  SESSION_ENTRY_WORKSPACE_FILE_REWIND,
  SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
] as const;

export type SessionEntryType = (typeof SESSION_ENTRY_TYPES)[number];

export interface SessionEntryInfo {
  id: string;
  sessionID: SessionId;
  type: SessionEntryType | string;
  // session entry 既承载用户/工具活动，也承载 session-local 配置快照。
  // 配置恢复或切换只应更新 entry 自己的版本，不能把任务活动时间伪装成“刚刚”。
  touchSession?: boolean;
  time: {
    created: number;
    updated: number;
  };
  /**
   * 逻辑 payload，不等同于数据库 JSON。runtime/model_selection 的读写为公共
   * ModelSelection（无选择沿用 null）；SQLite adapter 负责 modelSelection 包装，
   * 旧平铺字段仅供一次性迁移/回滚，不能暴露给普通消费者或复制到 fork 子记录。
   */
  data: unknown;
}

// ── session_input 账本──
// 输入的 durable 生命周期：admitted（已接受，排队/待注入）→ promoted（已消费成
// transcript user message，与消息持久化同事务）/ cancelled（用户删除队列项等）/
// discarded（session_resumed=重启不保留队列；user_cleared=heldQueue 清空发送）/
// failed（已接受但运行时无法启动；保留终态，重启时禁止再改写成 discarded）。
// id = input/command id（admission 时即存在）；promoted_message_id 是 nullable 外键——
// messageId 在 drain 时才生成。startNow 也必须先经过 durable admission：即使 CLI 在 ACK 后、
// user message 原子 promotion 前崩溃，恢复端也能把输入明确标成 discarded。
export type SessionInputDelivery = "startNow" | "guide" | "queue";

export type SessionInputStatus = "admitted" | "promoted" | "cancelled" | "discarded" | "failed";

export interface SessionInputRecord {
  id: string;
  sessionID: SessionId;
  kind: string;
  delivery: SessionInputDelivery;
  payload: { text: string; [key: string]: unknown };
  admittedSequence: number;
  promotedSequence?: number;
  promotedMessageID?: MessageId;
  status: SessionInputStatus;
  statusReason?: string;
  time: { created: number; updated: number };
}
