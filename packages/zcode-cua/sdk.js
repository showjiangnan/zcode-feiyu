// Modified by ZCode Feiyu contributors (2026).
/** Persistent, observation-bound application objects for the shared Node REPL. */

export function createComputerUseSDK(bridge) {
  const call = async (method, input = {}) => {
    bridge.assertAvailable();
    const result = await bridge.call(method, input);
    const body = result.structuredContent || {};
    if (result.isError) {
      const error = body.error || body;
      throw Object.assign(
        new Error(
          error.message ||
            result.content?.find((c) => c.type === "text")?.text ||
            "Computer control failed",
        ),
        { code: error.code || "control_failed", details: error.details },
      );
    }
    return body;
  };
  const access = async (input) => {
    await call("request_access", input);
  };
  const object = (selection) => {
    selection = { ...selection };
    let observation;
    let image;
    // getState/request_access 失败也会使旧证据无效；只在 action catch 清理会永久携带旧窗口。
    const guardedCall = async (method, input) => {
      try {
        return await call(method, input);
      } catch (error) {
        // 按错误码枚举会漏掉新的一致性/代际失败；失败不能证明旧证据仍有效，统一失效。
        observation = undefined;
        image = undefined;
        throw error;
      }
    };
    const access = async (input) => {
      await guardedCall("request_access", input);
    };
    const base = () => ({
      ...selection,
      ...(observation
        ? {
            targetId: observation.targetId,
            windowId: observation.windowId,
            observationId: observation.observationId,
          }
        : {}),
    });
    const absorb = (result) => {
      const state = result.state || result;
      if (state.observationId) {
        observation = state;
        image = state.image || undefined;
      }
      return state;
    };
    const action = async (method, input = {}) => {
      await access(selection);
      const args = { ...base(), ...input };
      if (["click", "move", "drag", "scroll"].includes(method) && !args.elementId) {
        if (!image?.imageId)
          throw Object.assign(
            new Error("Read the target window image before using image coordinates"),
            { code: "observation_required" },
          );
        args.imageId = image.imageId;
      }
      return absorb(await guardedCall(method, args));
    };
    const readState = async (options) => {
      for (let attempt = 0; ; attempt++) {
        try {
          const state = absorb(await guardedCall("get_state", { ...base(), ...options }));
          // 结构树在按应用初始化后可能尚未就绪；只重读 busy，不把不支持的目标改称成功。
          if (options.text !== false && state.channels?.text?.status === "busy" && attempt < 2)
            continue;
          return state;
        } catch (error) {
          // 启动窗口可能在采样间改变几何；只重新读取原目标，绝不重放输入或扩大 deadline。
          if (error.code !== "inconsistent_observation" || attempt >= 2) throw error;
        }
      }
    };
    const api = {
      getState: async (options = {}) => {
        await access(selection);
        try {
          return await readState(options);
        } catch (error) {
          if (
            error.code !== "target_unavailable" ||
            selection.windowId ||
            selection.targetId ||
            options.autoLaunch === false
          )
            throw error;
          const launched = await guardedCall("launch_app", selection);
          selection = { ...selection, appId: launched.appId, pid: launched.pid };
          await access(selection);
          return await readState(options);
        }
      },
      listWindows: async () => {
        await access(selection);
        return (await guardedCall("list_windows", selection)).windows || [];
      },
      activate: (options) => action("activate", options),
      click: (options) => action("click", options),
      move: (options) => action("move", options),
      drag: (options) => action("drag", options),
      scroll: (options) => action("scroll", options),
      pressKey: (key) => action("press_key", typeof key === "string" ? { key } : key),
      typeText: (text) => action("type_text", typeof text === "string" ? { text } : text),
      setValue: (options) => action("set_value", options),
      secondaryAction: (options) => action("secondary_action", options),
      selectText: (options) => action("select_text", options),
      getWindow: (window) =>
        object({
          ...selection,
          ...(typeof window === "number"
            ? { windowId: window }
            : typeof window === "string"
              ? { targetId: window }
              : window),
        }),
      close: async () => {
        await guardedCall("close_target", base());
        observation = undefined;
        image = undefined;
      },
    };
    // SDK aliases share one observation owner; they never keep a second state cache.
    api.get_state = api.getState;
    api.press_key = api.pressKey;
    api.type_text = api.typeText;
    api.set_value = api.setValue;
    api.secondary_action = api.secondaryAction;
    api.select_text = api.selectText;
    return Object.freeze(api);
  };
  const sdk = {
    initialize: async () => ({
      ...(await call("capabilities")),
      documentationRoot: bridge.documentationRoot,
    }),
    documentationRoot: bridge.documentationRoot,
    listApps: async () => (await call("list_apps")).apps || [],
    getApp: (app) => object(typeof app === "string" ? { appId: app } : app),
    getWindow: (selection) => object(selection),
    launchApp: async (app) => {
      const selection = typeof app === "string" ? { appId: app } : app;
      await access(selection);
      const result = await call("launch_app", selection);
      return object({ appId: result.appId, pid: result.pid });
    },
    stop: async () => call("stop_computer_control"),
  };
  sdk.computer = sdk;
  return Object.freeze(sdk);
}
