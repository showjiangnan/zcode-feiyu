// Modified by ZCode Feiyu contributors (2026).
import { useCallback, useEffect, useRef, useState } from "react";
import { DesktopCommandIds } from "@zcode/shared";
import { isControlSnapshot, type ControlUiRequest } from "@zcode/zcode-cua/control-contract";
import { usePlatform } from "./usePlatform.js";
import { useServices } from "./useServices.js";
import { useComputerControlStore } from "@/store/computerControlStore.js";
import { logger } from "@/logger.js";
import { useNativeControlPresentation } from "./useNativeControlPresentation.js";

export function useComputerControl(
  workspacePath: string,
  workspaceIdentity?: string,
  sessionId?: string | null,
) {
  const platform = usePlatform();
  const service = useServices().cuaPermissionService;
  const presentation = useNativeControlPresentation();
  const presentationSent = useRef<{ credential: string; value: string } | undefined>(undefined);
  const key = `${workspaceIdentity?.trim() || workspacePath}\0${sessionId || ""}`;
  const snapshot = useComputerControlStore((state) => state.snapshots[key]);
  const credential = useRef<string | undefined>(undefined);
  const generation = useRef(0);
  const active = useRef(false);
  const requestSequence = useRef(0);
  const [nativePlatform, setNativePlatform] = useState<string>();
  const [error, setError] = useState<string>();
  const [availabilityError, setAvailabilityError] = useState<string>();
  const [pending, setPending] = useState(false);
  const command = useCallback(
    async (action: ControlUiRequest["action"], values: Partial<ControlUiRequest> = {}) => {
      if (!service || !credential.current)
        throw new Error("Computer control requires the local desktop");
      const epoch = generation.current;
      const sequence = ++requestSequence.current;
      const request = {
        ...values,
        action,
        credential: credential.current,
        workspacePath,
        workspaceIdentity,
      };
      let result: unknown;
      try {
        result = await service.controlUi(request);
      } catch (failure) {
        // Host 重启后凭据会轮换。只恢复读取；批准/停止等写命令由用户重新提交。
        if (action !== "snapshot" || !platform.executeDesktopCommand) throw failure;
        const native = (await platform.executeDesktopCommand(
          DesktopCommandIds.GetComputerControlUi,
        )) as { credential?: unknown } | undefined;
        if (
          generation.current !== epoch ||
          typeof native?.credential !== "string" ||
          native.credential === credential.current
        )
          throw failure;
        credential.current = native.credential;
        result = await service.controlUi({ ...request, credential: native.credential });
      }
      if (
        active.current &&
        generation.current === epoch &&
        sequence === requestSequence.current &&
        isControlSnapshot(result)
      )
        useComputerControlStore.getState().publish(key, result);
      return result;
    },
    [service, workspacePath, workspaceIdentity, key, platform],
  );
  useEffect(() => {
    const epoch = ++generation.current;
    active.current = true;
    setError(undefined);
    setAvailabilityError(undefined);
    setPending(false);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (disposed || document.visibilityState === "hidden") {
        if (!disposed) timer = setTimeout(() => void poll(), 1000);
        return;
      }
      const started = performance.now();
      try {
        await command("snapshot");
        if (!disposed && presentation.current && credential.current) {
          const next = {
            credential: credential.current,
            value: JSON.stringify(presentation.current),
          };
          if (
            presentationSent.current?.credential !== next.credential ||
            presentationSent.current.value !== next.value
          ) {
            // 只同步主题/语言变更或 Host 凭据换代；展示投影不应每帧重复走服务调用。
            await command("presentation", { presentation: presentation.current })
              .then(() => {
                presentationSent.current = next;
              })
              .catch(() => undefined);
          }
        }
        if (!disposed) setAvailabilityError(undefined);
      } catch (failure) {
        if (!disposed) {
          setAvailabilityError(failure instanceof Error ? failure.message : String(failure));
          logger.debug("Computer control presentation unavailable");
        }
      }
      if (!disposed)
        timer = setTimeout(
          () => void poll(),
          Math.max(
            40,
            (useComputerControlStore.getState().snapshots[key]?.sources.length ||
            useComputerControlStore.getState().snapshots[key]?.approvals.length
              ? 200
              : 1000) -
              (performance.now() - started),
          ),
        );
    };
    if (workspacePath && platform.executeDesktopCommand && service) {
      void platform
        .executeDesktopCommand(DesktopCommandIds.GetComputerControlUi)
        .then((value) => {
          if (disposed || generation.current !== epoch) return;
          const native = value as { credential?: unknown; platform?: string } | undefined;
          setNativePlatform(native?.platform);
          credential.current =
            typeof native?.credential === "string" ? native.credential : undefined;
          if (credential.current && sessionId) void poll();
        })
        .catch(() => {
          /* Web/remote platforms do not have native UI authority. */
        });
    }
    return () => {
      disposed = true;
      active.current = false;
      generation.current++;
      clearTimeout(timer);
      if (credential.current)
        void command("visibility", { sourceIds: [], subscriber: key }).catch(() => undefined);
      credential.current = undefined;
      presentationSent.current = undefined;
      useComputerControlStore.getState().release(key);
    };
  }, [sessionId, workspacePath, platform, service, key, command, presentation]);
  const act = useCallback(
    async (action: ControlUiRequest["action"], values?: Partial<ControlUiRequest>) => {
      const epoch = generation.current;
      setPending(true);
      setError(undefined);
      try {
        await command(action, values);
      } catch (failure) {
        if (generation.current === epoch)
          setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        if (generation.current === epoch) setPending(false);
      }
    },
    [command],
  );
  return {
    snapshot,
    command,
    act,
    pending,
    error: error || availabilityError,
    nativePlatform,
    subscriber: key,
  };
}
