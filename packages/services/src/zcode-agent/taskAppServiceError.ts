import type { TaskAppError } from "@zcode/shared";

export class TaskServiceError extends Error {
  constructor(
    readonly code: TaskAppError["code"],
    message: string,
  ) {
    super(message);
  }
}
