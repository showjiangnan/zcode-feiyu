import { useCallback, useEffect, useRef, useState } from "react";
import type { RcsClient, RcsHost, RcsSave, RcsSettings, RcsStatus } from "@zcode/shared";
import { usePlatform } from "./usePlatform.js";

export function useRcsSettings() {
  const service = usePlatform().rcs;
  const [settings, setSettings] = useState<RcsSettings | null>(null);
  const [hosts, setHosts] = useState<RcsHost[]>([]);
  const [clients, setClients] = useState<RcsClient[]>([]);
  const [status, setStatus] = useState<RcsStatus>({ state: "disabled" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const generation = useRef(0);
  const running = useRef(false);
  useEffect(() => {
    active.current = true;
    ++generation.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    if (service) {
      void Promise.all([service.getSettings(), service.listHosts()])
        .then(([config, directory]) => {
          if (!cancelled) {
            setSettings(config);
            setHosts(directory);
          }
        })
        .catch((cause) => {
          if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
        });
      const observe = async () => {
        try {
          const next = await service.getStatus();
          if (cancelled) return;
          setStatus(next);
          if (next.state === "online") {
            const list = await service.listClients();
            if (!cancelled) setClients(list);
          } else setClients([]);
        } catch (cause) {
          if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          if (!cancelled)
            timer = setTimeout(() => {
              void observe();
            }, 2000);
        }
      };
      void observe();
    }
    return () => {
      cancelled = true;
      active.current = false;
      ++generation.current;
      clearTimeout(timer);
    };
  }, [service]);
  const run = useCallback(async <T>(action: () => Promise<T>): Promise<T | undefined> => {
    if (running.current) return;
    const owner = generation.current;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (cause) {
      if (active.current && owner === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause));
      return undefined;
    } finally {
      running.current = false;
      if (active.current && owner === generation.current) setBusy(false);
    }
  }, []);
  const save = useCallback(
    (input: RcsSave) =>
      run(async () => {
        if (!service) throw new Error("CAPABILITY_DENIED");
        const owner = generation.current;
        const saved = await service.saveSettings(input);
        if (active.current && owner === generation.current) setSettings(saved);
        return saved;
      }),
    [run, service],
  );
  return { service, settings, hosts, clients, status, busy, error, save, run };
}
