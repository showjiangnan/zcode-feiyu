import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { TerminalFontFamilySource, TerminalThemeProfile } from "./terminalProfile.js";

export interface TerminalWindowsPtyInfo {
  backend: "conpty" | "winpty";
  buildNumber?: number;
}

export interface TerminalProfile {
  id: string;
  cwd: string;
  shell: string;
  fontFamily: string;
  fontSize?: number;
  theme?: TerminalThemeProfile;
  fontFamilySource: TerminalFontFamilySource;
  windowsPty?: TerminalWindowsPtyInfo;
}
export interface TerminalChunk {
  sequence: number;
  data: string;
}

export interface ITerminalService {
  list?(): Promise<TerminalProfile[]>;
  attach?(params: {
    id: string;
    afterSequence?: number;
  }): Promise<TerminalProfile & { chunks: TerminalChunk[]; truncated: boolean; sequence: number }>;
  detach?(params: { id: string }): Promise<void>;
  onDynamicReplayData?(id: string): Event<TerminalChunk>;
  create(params: { cols: number; rows: number; cwd?: string }): Promise<{
    id: string;
    shell: string;
    fontFamily: string;
    fontSize?: number;
    theme?: TerminalThemeProfile;
    fontFamilySource: TerminalFontFamilySource;
    windowsPty?: TerminalWindowsPtyInfo;
  }>;
  write(params: { id: string; data: string }): Promise<void>;
  resize(params: { id: string; cols: number; rows: number }): Promise<void>;
  dispose(params: { id: string }): Promise<void>;
  onDynamicData(id: string): Event<string>;
  onDynamicExit(id: string): Event<number>;
}

export const ITerminalService = createServiceDescriptor<ITerminalService>(ServiceChannels.Terminal);
