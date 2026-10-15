// Modified by ZCode Feiyu.
import { useCallback, useEffect, useReducer, useState } from "react";
import type { TeamorouterBalance } from "@zcode/shared";
import { useServices } from "./useServices.js";

type BalanceState =
  | { status: "loading" }
  | { status: "ready"; balance: TeamorouterBalance }
  | { status: "error"; kind: string };

/** 结果只属于当前 Environment/供应商/已保存版本；不缓存另一账户的金额。 */
export function useTeamorouterBalance(providerId: string, settingsRevision: number) {
  const { providerSettingsService: service } = useServices();
  const [refreshVersion, refresh] = useReducer((value: number) => value + 1, 0);
  const [owned, setOwned] = useState<{
    service: typeof service;
    providerId: string;
    settingsRevision: number;
    refreshVersion: number;
    state: BalanceState;
  }>();
  const current =
    owned?.service === service &&
    owned.providerId === providerId &&
    owned.settingsRevision === settingsRevision &&
    owned.refreshVersion === refreshVersion;
  useEffect(() => {
    let active = true;
    const commit = (state: BalanceState) => {
      if (active) setOwned({ service, providerId, settingsRevision, refreshVersion, state });
    };
    commit({ status: "loading" });
    void service.getTeamorouterBalance(providerId).then(
      (balance) => commit({ status: "ready", balance }),
      (error: unknown) => {
        const kind =
          error instanceof Error ? error.message.replace(/^teamorouter:/u, "") : "failed";
        commit({
          status: "error",
          kind: [
            "missing-key",
            "unauthorized",
            "rate-limited",
            "server-error",
            "network-error",
            "invalid-response",
            "conflict",
            "unsupported",
          ].includes(kind)
            ? kind
            : "failed",
        });
      },
    );
    return () => {
      active = false;
    };
  }, [service, providerId, settingsRevision, refreshVersion]);
  return {
    state: current ? owned.state : { status: "loading" as const },
    refresh: useCallback(() => refresh(), []),
  };
}
