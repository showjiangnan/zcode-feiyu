// Modified by ZCode Feiyu.
import { createContext } from "react";

export const BotGroupMemberNamesContext = createContext<{
  botId: string;
  chatId: string;
  names: Record<string, string>;
} | null>(null);
