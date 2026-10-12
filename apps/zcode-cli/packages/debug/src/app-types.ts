// Modified by ZCode Feiyu.
export interface SourceInputs {
  projectId: string;
  logDir: string;
  eventPath: string;
  dbPath: string;
  sessionId: string;
}

export interface ObservationEventState {
  connected: boolean;
  error: string | null;
  lastChangeAt?: string;
  watchedPathCount: number;
}

export type EnvShell = "posix" | "powershell" | "cmd";

export type DebugView = "trace" | "gantt" | "network";
