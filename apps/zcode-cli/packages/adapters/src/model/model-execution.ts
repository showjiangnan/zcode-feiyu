// Modified by ZCode Feiyu.
import {
  getCurrentModelInvocationContext,
  ModelProtocolError,
  ModelErrorCode,
  ModelFailureReason,
} from "@zcode/contracts";
import { createSubscriptionInferenceFetch } from "@zcode/provider-node";
import { getSubscriptionFastServiceTier } from "@zcode/shared/chatgpt-subscription-catalog";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  type Logger,
  type ModelId,
  type ModelProviderId,
  type ModelRequestAuth,
  type ProviderEndpointRoutingPort,
} from "@zcode/contracts";
import {
  compileModelOptionMaps,
  type CompiledModelOptionMaps,
  type ModelOptionValues,
} from "@zcode/model-option-map";
import type { RegistryProviderConfig } from "@zcode/provider";
import {
  supportsTeamorouterFast,
  supportsModelSpeed,
  getModelSpeedOptions,
  type ModelSpeedCapabilities,
  withOpenRouterAttributionHeaders,
  type ModelSpeed,
} from "@zcode/shared";
import { createAnthropicCompatFetch } from "./anthropic-stream-compat.js";
import {
  applyModelRequestAuth,
  normalizeAnthropicBaseURL,
  toAiSdkProviderConfig,
  withAnthropicAuthorizationHeader,
} from "./model-execution-config.js";
import {
  AiSdkBoundModelResolution,
  AiSdkModelExecutionConfig,
  AiSdkModelExecutionOptions,
  AiSdkModelSnapshot,
  AiSdkNetworkConfig,
  AiSdkProviderConfig,
  AiSdkResolvedModel,
  EnvRecord,
  LanguageModelFactory,
  ProviderFetch,
} from "./model-execution-types.js";
import { createModelOptionMapFetch, type RawRequestBodyCapture } from "./model-option-map-fetch.js";
import {
  mergeModelRequestHeaders,
  withoutModelQuerySourceHeader,
} from "./model-request-headers.js";
import { createOpenAIResponsesJsonCompatFetch } from "./openai-responses-json-compat.js";
import {
  createProviderBusinessErrorFetch,
  createProviderProxyFetch,
} from "./provider-business-transport.js";
import { createProviderEndpointRoutingFetch } from "./provider-endpoint-routing-fetch.js";
import { createModelRequestSecurityState } from "./request-security-edition/index.js";
import type { ModelRequestSecurityPort } from "./request-security.js";

export class AiSdkModelExecution {
  private readonly env: EnvRecord;
  private readonly defaultHeaders: Record<string, string>;
  private readonly network: AiSdkNetworkConfig;
  private readonly endpointRoutingPort?: ProviderEndpointRoutingPort;
  private readonly logger?: Logger;
  private readonly baseTransport?: ProviderFetch;
  private readonly providerTransports = new Map<string, ProviderFetch>();
  private readonly requestSecurity: ModelRequestSecurityPort;

  constructor(config: AiSdkModelExecutionConfig = {}, options: AiSdkModelExecutionOptions = {}) {
    this.env = config.env ?? process.env;
    this.defaultHeaders = { ...config.defaultHeaders };
    this.network = { ...config.network };
    this.endpointRoutingPort = config.endpointRoutingPort;
    this.logger = options.logger;
    this.baseTransport = options.transport;
    this.requestSecurity = (
      options.requestSecurityState ?? createModelRequestSecurityState()
    ).createExecution({ logger: options.logger });
  }

  /**
   * 固定一个 Model 创建时使用的 Provider 静态事实。
   *
   * 请求期鉴权只覆盖 API Key 与 Header；Registry 后续热更新不会让已经创建的
   * Model 静默切换 Endpoint、协议、Provider Options 或 SDK Factory。
   */
  bindModel(input: {
    readonly providerId: string;
    readonly modelId: string;
    readonly providerConfig: RegistryProviderConfig;
    readonly supportsJsonSchemaOutput: boolean;
    readonly fastMode?: boolean;
    readonly speedCapabilities?: ModelSpeedCapabilities | null;
    readonly optionSpecs: {
      readonly reasoningLevel: { readonly map: string };
      readonly maxOutputTokens: { readonly map: string };
    };
  }): AiSdkBoundModelResolution {
    const snapshot = this.captureModelSnapshot(input);
    const optionMaps = compileModelOptionMaps(input.optionSpecs);
    return {
      // 这里只构造不执行请求的基础 Model；真正请求必须通过 resolveRequest 绑定完整 options。
      resolved: this.resolveSnapshot(snapshot, undefined, undefined, undefined),
      resolveRequest: ({ options, requestAuth }) =>
        this.resolveSnapshot(snapshot, requestAuth, optionMaps, options),
    };
  }

  private captureModelSnapshot(input: {
    readonly providerId: string;
    readonly modelId: string;
    readonly providerConfig: RegistryProviderConfig;
    readonly supportsJsonSchemaOutput: boolean;
    readonly fastMode?: boolean;
    readonly speedCapabilities?: ModelSpeedCapabilities | null;
  }): AiSdkModelSnapshot {
    const configuredProvider = toAiSdkProviderConfig(input.providerId, input.providerConfig);
    // 重构后模型 SDK 曾只接到用户 Header，漏掉版本和站点归因；在公共绑定边界恢复，
    // 不依赖签名成功，不给各业务重复补头，也不修改 Provider 或已绑定 Model 的配置。
    configuredProvider.headers = mergeModelRequestHeaders(
      withOpenRouterAttributionHeaders(this.defaultHeaders, configuredProvider.baseURL),
      configuredProvider.headers,
    );
    const apiKey = this.resolveApiKey(configuredProvider);
    return {
      providerConfig: {
        ...configuredProvider,
        ...(apiKey ? { apiKey } : {}),
        ...(configuredProvider.headers ? { headers: { ...configuredProvider.headers } } : {}),
        ...(configuredProvider.providerOptions
          ? { providerOptions: { ...configuredProvider.providerOptions } }
          : {}),
      },
      providerId: input.providerId as ModelProviderId,
      modelId: input.modelId as ModelId,
      supportsJsonSchemaOutput: input.supportsJsonSchemaOutput,
      supportsSpeed: supportsModelSpeed(input.providerConfig, input.modelId),
      allowedSpeeds: getModelSpeedOptions(input.providerConfig, input.modelId, input),
      fastMode:
        input.fastMode === true &&
        supportsTeamorouterFast(
          input.providerConfig.api.type,
          input.providerConfig.api.baseUrl,
          input.modelId,
        ),
    };
  }

  private resolveSnapshot(
    snapshot: AiSdkModelSnapshot,
    requestAuth: ModelRequestAuth | undefined,
    optionMaps: CompiledModelOptionMaps | undefined,
    optionValues: (ModelOptionValues & { readonly speed?: ModelSpeed }) | undefined,
  ): AiSdkResolvedModel {
    const providerConfig = applyModelRequestAuth(snapshot.providerConfig, requestAuth);
    if (optionValues?.speed && !snapshot.allowedSpeeds.includes(optionValues.speed)) {
      throw new ModelProtocolError(
        ModelErrorCode.InvalidModelRequest,
        "model_speed_not_supported",
        {
          reason: ModelFailureReason.InvalidRequest,
          retryable: false,
          source: "runtime",
        },
      );
    }
    // Model 创建时的 Provider 事实必须被冻结在当前 binding 中。若按 providerId 缓存
    // factory，配置更新后创建的新 Model 会错误复用旧 Endpoint / Header / API Key。
    const rawRequestBodyCapture: RawRequestBodyCapture = {};
    const factory = this.createFactory(
      snapshot.providerId,
      snapshot.modelId.toString(),
      providerConfig,
      optionMaps,
      optionValues,
      rawRequestBodyCapture,
      snapshot.supportsJsonSchemaOutput,
      snapshot.fastMode,
      snapshot.providerConfig.access?.type === "zhipu-account" ? requestAuth?.apiKeyId : undefined,
      snapshot.supportsSpeed ? optionValues?.speed : undefined,
    );
    return {
      baseURL: providerConfig.baseURL,
      headers: providerConfig.headers,
      providerId: snapshot.providerId,
      modelId: snapshot.modelId,
      model: factory(snapshot.modelId.toString()),
      providerKind: providerConfig.kind,
      subscriptionAccess: providerConfig.access.type === "chatgpt-subscription",
      ...(providerConfig.access.type === "chatgpt-subscription"
        ? {
            subscriptionSearchToolType:
              providerConfig.access.modelCapabilities?.[snapshot.modelId]?.webSearchToolType,
          }
        : {}),
      providerOptions: providerConfig.providerOptions,
      rawRequestBodyCapture,
      requestObservations: this.requestSecurity,
    };
  }

  private createFactory(
    providerId: string,
    modelId: string,
    providerConfig: AiSdkProviderConfig,
    optionMaps: CompiledModelOptionMaps | undefined,
    optionValues: ModelOptionValues | undefined,
    rawRequestBodyCapture: RawRequestBodyCapture,
    supportsJsonSchemaOutput: boolean,
    fastMode: boolean,
    apiKeyId?: string,
    speed?: ModelSpeed,
  ): LanguageModelFactory {
    const apiKey = this.resolveApiKey(providerConfig);
    // SDK 会合并 factory 默认 header；必须在这里去掉静态来源，才能保证缺失时真正省略。
    const headers = withoutModelQuerySourceHeader(providerConfig.headers);
    const networkTransport =
      providerConfig.access.type === "chatgpt-subscription"
        ? createSubscriptionInferenceFetch(
            providerConfig.access,
            this.env,
            getCurrentModelInvocationContext()?.executionScope,
          )
        : this.resolveProviderTransport(providerId);
    // ID 属于当前 attempt，不能放入按 Provider 缓存的 transport，避免切换账号后串用。
    const providerTransport =
      this.endpointRoutingPort && providerConfig.access.type !== "chatgpt-subscription"
        ? createProviderEndpointRoutingFetch({
            fetch: networkTransport,
            routingPort: this.endpointRoutingPort,
            apiKeyId,
          })
        : networkTransport;
    const requestTransport = this.requestSecurity.protectTransport({
      providerId,
      providerConfig,
      transport: providerTransport,
    });
    // 原先 options 链路误用 routing transport，旁路了请求安全校验；两种参数映射分支都复用保护后的 transport。
    const mappedTransport =
      optionMaps && optionValues
        ? createModelOptionMapFetch({
            capture: rawRequestBodyCapture,
            fetch: requestTransport,
            maps: optionMaps,
            values: optionValues,
            fastMode,
            speed,
            // 显式目录许可使用该模型的 wire id；旧订阅目录沿 priority，中转沿 fast。
            fastServiceTier:
              providerConfig.access.type === "chatgpt-subscription"
                ? getSubscriptionFastServiceTier(providerConfig.access.modelCapabilities?.[modelId])
                : "fast",
          })
        : requestTransport;
    const optionFetch = createProviderBusinessErrorFetch({
      fetch: mappedTransport,
      providerId,
      providerKind: providerConfig.kind,
    });

    switch (providerConfig.kind) {
      case "openai": {
        const provider = createOpenAI({
          apiKey,
          baseURL: providerConfig.baseURL,
          fetch: createOpenAIResponsesJsonCompatFetch(optionFetch),
          headers,
        });
        return provider.responses as LanguageModelFactory;
      }

      case "anthropic": {
        const provider = createAnthropic({
          apiKey,
          baseURL: normalizeAnthropicBaseURL(providerConfig.baseURL),
          fetch: createAnthropicCompatFetch(optionFetch),
          headers: withAnthropicAuthorizationHeader(apiKey, headers),
        });
        return provider as LanguageModelFactory;
      }

      case "openai-compatible": {
        const provider = createOpenAICompatible<string, string, string, string>({
          name: providerConfig.name ?? providerId,
          baseURL: providerConfig.baseURL,
          apiKey,
          fetch: optionFetch,
          headers,
          // OpenAI Compatible 流式 usage 需要显式请求，Usage 是执行结果的一部分。
          includeUsage: true,
          // 缺少这一装配时 SDK 默认 false，会把已声明支持的 Schema 静默降为 JSON object。
          // 使用 binding 冻结的模型事实，不按供应商或实时 Registry 另查一套能力。
          supportsStructuredOutputs: supportsJsonSchemaOutput,
        });
        return provider as LanguageModelFactory;
      }
    }
  }

  private resolveApiKey(providerConfig: AiSdkProviderConfig): string | undefined {
    return providerConfig.apiKey;
  }

  private resolveProviderTransport(providerId: string): ProviderFetch {
    const current = this.providerTransports.get(providerId);
    if (current) {
      return current;
    }
    const networkTransport = createProviderProxyFetch({
      caCertFile: this.network.caCertFile,
      env: this.env,
      fetch: this.baseTransport,
      httpProxy: this.network.httpProxy,
      noProxy: this.network.noProxy,
    });
    this.providerTransports.set(providerId, networkTransport);
    return networkTransport;
  }
}

export type {
  AiSdkBoundModelResolution,
  AiSdkModelExecutionConfig,
  AiSdkModelExecutionOptions,
  AiSdkNetworkConfig,
  AiSdkProviderKind,
  AiSdkResolvedModel,
  EnvRecord,
  ProviderBusinessErrorFetchOptions,
  ProviderBusinessErrorOptions,
} from "./model-execution-types.js";
export {
  isProviderBusinessError,
  ProviderBusinessError,
  readProviderBusinessFailureFromBody,
} from "./provider-business-error.js";
export { createProviderBusinessErrorFetch } from "./provider-business-transport.js";
