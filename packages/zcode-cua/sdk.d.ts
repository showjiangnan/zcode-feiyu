// Modified by ZCode Feiyu contributors (2026).
export interface ComputerControlSelection {
  appId?: string;
  pid?: number;
  windowId?: number;
  targetId?: string;
}
export interface ComputerRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ComputerApplication {
  appId: string;
  appKey?: string;
  pid?: number;
  displayName?: string;
  isRunning?: boolean;
  path?: string;
  fileIdentity?: string;
  processIncarnation?: string;
}
export interface ComputerWindow extends ComputerControlSelection {
  targetId: string;
  windowId: number;
  title: string;
  frame: ComputerRect;
  structureAvailable?: boolean;
  structureReason?: string;
}
export interface ComputerElement {
  elementId: string;
  path: string;
  role: string;
  label?: string;
  value?: string;
  secure?: boolean;
  enabled?: boolean;
  focused?: boolean;
  actions: string[];
  frame?: ComputerRect;
}
export interface ComputerImage {
  imageId: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  coordinateSpace: "image-pixels";
  colorSpace?: string;
}
export interface ComputerObservation extends ComputerWindow {
  observationId: string;
  revision: string;
  capturedAt: number;
  nodes?: ComputerElement[];
  image?: ComputerImage;
  imageBounds?: ComputerRect;
  channels?: Record<string, { status: string; reason?: string }>;
  fullReset?: boolean;
  truncated?: boolean;
  continuation?: { elementId: string; offset: number }[];
  diff?: {
    baseRevision: string;
    nextRevision: string;
    changed: ComputerElement[];
    removed: string[];
  };
}
export interface ComputerControlResult {
  status?: string;
  outcome?: string;
  acceptedSegments?: number;
  settled?: boolean;
  inputMode?: "isolated" | "foreground";
  state?: ComputerObservation;
  target?: ComputerWindow;
}
export interface ComputerObservationOptions {
  image?: boolean;
  text?: boolean;
  maxNodes?: number;
  childOffset?: number;
  elementId?: string;
  diff?: boolean;
  disableDiff?: boolean;
  baselineRevision?: string;
  region?: ComputerRect;
  autoLaunch?: boolean;
}
export type ComputerPoint = { x: number; y: number };
export type ComputerLocation = ComputerPoint | { elementId: string };
export interface ComputerActionOptions {
  verifyImage?: boolean;
  inputMode?: "isolated" | "foreground";
}
export type ComputerClickOptions = ComputerLocation &
  ComputerActionOptions & { button?: 0 | 1 | 2; clickCount?: 1 | 2 | 3 };
export type ComputerDragOptions = ComputerActionOptions & {
  path: ComputerPoint[];
  button?: 0 | 1 | 2;
};
export type ComputerScrollOptions = ComputerLocation &
  ComputerActionOptions & {
    dx?: number;
    dy?: number;
    unit?: "pixels" | "points" | "lines" | "pages";
  };
export type ComputerKeyOptions = ComputerActionOptions &
  ({ key: string } | { physicalKeyCode: number } | { scanCode: number; extended?: boolean });
export interface ComputerTypeOptions extends ComputerActionOptions {
  text: string;
  mode?: "unicode" | "clipboard";
}
export interface ComputerValueOptions extends ComputerActionOptions {
  elementId: string;
  text: string;
}
export interface ComputerSecondaryActionOptions extends ComputerActionOptions {
  elementId: string;
  action: string;
}
export interface ComputerTextSelectionOptions extends ComputerActionOptions {
  elementId: string;
  text: string;
  prefix?: string;
  suffix?: string;
  occurrence?: number;
  mode?: "select" | "before" | "after";
}
export interface ComputerControlObject {
  getState(options?: ComputerObservationOptions): Promise<ComputerObservation>;
  listWindows(): Promise<ComputerWindow[]>;
  activate(): Promise<ComputerControlResult>;
  click(options: ComputerClickOptions): Promise<ComputerControlResult>;
  move(options: ComputerLocation & ComputerActionOptions): Promise<ComputerControlResult>;
  drag(options: ComputerDragOptions): Promise<ComputerControlResult>;
  scroll(options: ComputerScrollOptions): Promise<ComputerControlResult>;
  pressKey(key: string | ComputerKeyOptions): Promise<ComputerControlResult>;
  typeText(text: string | ComputerTypeOptions): Promise<ComputerControlResult>;
  setValue(options: ComputerValueOptions): Promise<ComputerControlResult>;
  secondaryAction(options: ComputerSecondaryActionOptions): Promise<ComputerControlResult>;
  selectText(options: ComputerTextSelectionOptions): Promise<ComputerControlResult>;
  getWindow(window: number | string | ComputerControlSelection): ComputerControlObject;
  close(): Promise<void>;
}
export interface ComputerCapabilities {
  platform: "darwin" | "win32";
  protocolVersion: string;
  structure: boolean;
  capture: boolean;
  input: boolean;
  backgroundInput: boolean;
  backgroundInputScope?: "conditional-per-operation";
  inputRoutes?: { isolated: string; foreground: string };
  nativeFeedback?: { windowIndicators: boolean; agentPointer: boolean };
  nativeStop: boolean;
  interactiveDesktop: boolean;
  minimumOSVersion?: string;
}
export interface ComputerUseSDK {
  initialize(): Promise<ComputerCapabilities>;
  documentationRoot: string;
  listApps(): Promise<ComputerApplication[]>;
  getApp(app: string | ComputerControlSelection): ComputerControlObject;
  getWindow(selection: ComputerControlSelection): ComputerControlObject;
  launchApp(app: string | ComputerControlSelection): Promise<ComputerControlObject>;
  stop(): Promise<ComputerControlResult>;
  computer: ComputerUseSDK;
}
export declare function createComputerUseSDK(bridge: {
  assertAvailable(): void;
  documentationRoot: string;
  call(
    method: string,
    input: unknown,
  ): Promise<{
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: { type: string; text?: string }[];
  }>;
}): ComputerUseSDK;
