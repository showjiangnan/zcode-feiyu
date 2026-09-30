// Modified by ZCode Feiyu contributors (2026).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { backgroundContinuityStatusSchema } from "@zcode/shared";
import { usePlatform } from "./usePlatform.js";
import { createContinuityRequestGate } from "./continuityProjection.js";
import {
  backgroundReadFailed,
  backgroundReadSucceeded,
  backgroundStopFailed,
  backgroundStopStarted,
  backgroundStopSucceeded,
  initialBackgroundContinuity,
  visibleBackgroundError,
  type OwnedBackgroundContinuity,
} from "./backgroundContinuityState.js";

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function useBackgroundContinuity() {
  const platform = usePlatform();
  const [owned, setOwned] = useState<OwnedBackgroundContinuity<typeof platform>>(() =>
    initialBackgroundContinuity(platform),
  );
  const [stopping, setStopping] = useState(false);
  const owner = useMemo(
    () => ({ active: true, stopping: false, gate: createContinuityRequestGate() }),
    [platform],
  );
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  useEffect(() => {
    owner.active = true;
    setOwned(initialBackgroundContinuity(platform));
    setStopping(false);
    let reading = false;
    const refresh = async () => {
      if (reading || owner.stopping || !platform.readBackgroundContinuity) return;
      // 慢于轮询间隔的读取不能被下一次 poll 永久抢代；停止命令仍独立准入。
      reading = true;
      const request = owner.gate.begin();
      try {
        const status = backgroundContinuityStatusSchema.parse(
          await platform.readBackgroundContinuity(),
        );
        if (owner.active && ownerRef.current === owner && owner.gate.isCurrent(request))
          setOwned((previous) => backgroundReadSucceeded(previous, platform, status));
      } catch (cause) {
        if (owner.active && ownerRef.current === owner && owner.gate.isCurrent(request))
          setOwned((previous) => backgroundReadFailed(previous, errorMessage(cause)));
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = platform.readBackgroundContinuity
      ? setInterval(() => {
          void refresh();
        }, 2_000)
      : undefined;
    return () => {
      owner.active = false;
      owner.gate.invalidate();
      if (timer !== undefined) clearInterval(timer);
    };
  }, [owner, platform]);
  const stop = useCallback(async () => {
    if (!platform.stopBackgroundContinuity || owner.stopping) return;
    owner.stopping = true;
    setStopping(true);
    setOwned(backgroundStopStarted);
    // 停止前发出的 poll 可能晚于停止回执返回；使其失效，不能把失败/真实终态覆盖回 running。
    const request = owner.gate.begin();
    try {
      const status = backgroundContinuityStatusSchema.parse(
        await platform.stopBackgroundContinuity(),
      );
      if (owner.active && ownerRef.current === owner && owner.gate.isCurrent(request))
        setOwned(backgroundStopSucceeded(platform, status));
    } catch (cause) {
      if (owner.active && ownerRef.current === owner && owner.gate.isCurrent(request))
        setOwned((previous) => backgroundStopFailed(previous, errorMessage(cause)));
    } finally {
      owner.stopping = false;
      if (owner.active && ownerRef.current === owner) setStopping(false);
    }
  }, [owner, platform]);
  return {
    status: owned.platform === platform ? owned.status : null,
    error: visibleBackgroundError(owned, platform),
    stopping,
    stop,
    available: Boolean(platform.readBackgroundContinuity),
    canStop: Boolean(platform.stopBackgroundContinuity),
  };
}
