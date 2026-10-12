// Modified by ZCode Feiyu.
import {
  type ModelErrorCode as ModelErrorCodeType,
  type ModelFailureReason,
  type ModelRetryReason,
} from "@zcode/contracts";

export interface ClassifiedModelFailure {
  code: ModelErrorCodeType;
  message: string;
  reason: ModelFailureReason;
  retryReason: ModelRetryReason;
  retryable: boolean;
  retryAfterMs?: number;
  statusCode?: number;
}

export interface ProviderFailureDetails {
  providerErrorCode?: string;
  providerErrorMessage?: string;
  providerRequestId?: string;
}
