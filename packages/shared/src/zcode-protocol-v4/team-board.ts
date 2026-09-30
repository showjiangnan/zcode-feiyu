// Modified by ZCode Feiyu contributors (2026).
import { z } from "zod";

export const teamBoardTaskSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1).max(2_000),
    assigneeId: z.string().optional(),
    assigneeName: z.string().max(32).optional(),
    status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    result: z.string().max(2_000).optional(),
  })
  .strict();

export const teamBoardStateSchema = z
  .object({
    branchGeneration: z.number().int().nonnegative().default(0),
    revision: z.number().int().nonnegative(),
    tasks: z.array(teamBoardTaskSchema).max(64),
  })
  .strict();

export type TeamBoardTask = z.infer<typeof teamBoardTaskSchema>;
export type TeamBoardState = z.infer<typeof teamBoardStateSchema>;
export const EMPTY_TEAM_BOARD: TeamBoardState = { branchGeneration: 0, revision: 0, tasks: [] };
