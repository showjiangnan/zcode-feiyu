// Modified by ZCode Feiyu.
import {
  type Logger,
  type ModelId,
  type ModelProviderId,
  type ModelRequestAuth,
  type ProviderEndpointRoutingPort,
} from "@zcode/contracts";
import { type ModelOptionValues } from "@zcode/model-option-map";
import type { RegistryProviderConfig } from "@zcode/provider";
import type { LanguageModel } from "ai";
import { type RawRequestBodyCapture } from "./model-option-map-fetch.js";
import type { ModelRequestSecurityPort, ModelRequestSecurityState } from "./request-security.js";

export type AiSdkProviderKind = "openai" | "anthropic" | "openai-compatible";

export type EnvRecord = Record<string, string | undefined>;

export interface AiSdkProviderConfig {
  access: RegistryProviderConfig["access"];
  kind: AiSdkProviderKind;
  apiKey?: string;
  baseURL: string;
  headers?: Record<string, string>;
  providerOptions?: Record<string, unknown>;
  name?: string;
}

export interface AiSdkModelExecutionConfig {
  /** 执行环境提供的默认来源信息，不属于 Provider 持久化配置。 */
  defaultHeaders?: Readonly<Record<string, string>>;
  endpointRoutingPort?: ProviderEndpointRoutingPort;
  env?: EnvRecord;
  network?: AiSdkNetworkConfig;
}

export interface AiSdkModelExecutionOptions {
  requestSecurityState?: ModelRequestSecurityState;
  logger?: Logger;
  transport?: ProviderFetch;
}

export interface AiSdkNetworkConfig {
  caCertFile?: string;
  httpProxy?: string;
  noProxy?: string;
}

export interface AiSdkResolvedModel {
  baseURL?: string;
  headers?: Record<string, string>;
  providerId: ModelProviderId;
  modelId: ModelId;
  model: LanguageModel;
  providerKind: AiSdkProviderKind;
  providerOptions?: Record<string, unknown>;
  rawRequestBodyCapture?: RawRequestBodyCapture;
  requestObservations?: ModelRequestSecurityPort;
}

export interface AiSdkBoundModelResolution {
  readonly resolved: AiSdkResolvedModel;
  resolveRequest(input: {
    readonly options: ModelOptionValues;
    readonly requestAuth?: ModelRequestAuth;
  }): AiSdkResolvedModel;
}

export type LanguageModelFactory = (modelId: string) => LanguageModel;

export type ProviderFetch = typeof globalThis.fetch;

export type ProviderCode = string | number;

export interface ProviderBusinessErrorFetchOptions {
  caCertFile?: string;
  endpointRoutingPort?: ProviderEndpointRoutingPort;
  env?: EnvRecord;
  providerId: string;
  providerKind: AiSdkProviderKind;
  fetch?: ProviderFetch;
  httpProxy?: string;
  noProxy?: string;
}

export interface ProviderBusinessErrorOptions {
  providerCode?: ProviderCode;
  providerId: string;
  providerKind: AiSdkProviderKind;
  providerMessage?: string;
  providerRequestId?: string;
  responseBodySummary?: Record<string, unknown>;
  responseHeaders?: Record<string, string>;
  responseStatus?: number;
  statusCode?: number;
}

export interface AiSdkModelSnapshot {
  readonly fastMode: boolean;
  readonly supportsJsonSchemaOutput: boolean;
  readonly providerConfig: AiSdkProviderConfig;
  readonly providerId: ModelProviderId;
  readonly modelId: ModelId;
}

export interface ProviderProxyFetchOptions {
  caCertFile?: string;
  env?: EnvRecord;
  fetch?: ProviderFetch;
  httpProxy?: string;
  noProxy?: string;
}
