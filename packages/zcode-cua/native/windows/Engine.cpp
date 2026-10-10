// Modified by ZCode Feiyu contributors (2026).
#include "Control.hpp"
Engine::Engine() {
  try {
    ComPtr<IUIAutomation2> bounded;
    check(CoCreateInstance(CLSID_CUIAutomation8, nullptr, CLSCTX_INPROC_SERVER,
                           IID_PPV_ARGS(&bounded)), "UI Automation unavailable");
    check(bounded->put_ConnectionTimeout(250), "UIA connection timeout unavailable");
    check(bounded->put_TransactionTimeout(1000), "UIA transaction timeout unavailable");
    // 默认 UIA 自动聚焦会破坏后台隔离；显式 foreground 仍由原有激活路径控制。
    check(bounded->put_AutoSetFocus(FALSE), "UIA focus isolation unavailable");
    check(bounded.As(&automation), "UIA interface unavailable");
  } catch (const Fault &failure) {
    automation.Reset();
    automationFailure = {{"code", failure.code}, {"message", failure.what()}, {"details", failure.details}};
  }
}
Json Engine::capabilities() {
  const bool desktop = interactiveDesktop(), capture = captureSupported(), stop = hasNativeStopMonitor();
  return {{"platform", "win32"}, {"pid", GetCurrentProcessId()}, {"protocolVersion", "zcode-cua/1"},
          {"minimumOSVersion", "10.0.19041"}, {"structure", automation.Get() != nullptr},
          {"structureFailure", automationFailure}, {"capture", capture}, {"input", desktop && stop},
          {"backgroundInput", desktop && stop}, {"backgroundInputScope", "conditional-per-operation"},
          {"inputRoutes", {{"isolated", "bounded-window-messages-and-uia"}, {"foreground", "system-events"}}},
          {"scrollPrecision", "approximate-wheel"}, {"nativeFeedback", {{"windowIndicators", true}, {"agentPointer", true}}},
          {"nativeStop", stop}, {"interactiveDesktop", desktop}};
}
Engine::~Engine() {
  shutdownControlFeedback();
  try {
    if (cleanupInput())
      release();
    else
      abandon();
  } catch (...) {
    abandon();
  }
}
void Engine::acquire(const Operation &op) {
  if (owner == op.key())
    return;
  if (!owner.empty())
    throw Fault("device_busy", "Another task owns native input");
  device.acquire(!isolatedInput);
  owner = op.key();
  {
    std::lock_guard<std::mutex> lock(stateMutex);
    controlContext = op.context;
  }
}
void Engine::release(const std::string &key) {
  if (!key.empty() && owner != key)
    return;
  clearControlFeedback(key.empty() ? owner : key);
  device.release();
  owner.clear();
  inputWindow = nullptr;
}
void Engine::abandon() {
  device.abandon();
  owner.clear();
  inputWindow = nullptr;
}
void Engine::qualify(const Operation &op, const Json &params, bool mutation) {
  op.guard();
  if (op.context.value("runtimeScope", "") != "main" ||
      op.context.value("sessionId", "").empty() ||
      op.context.value("turnId", "").empty() ||
      !params.value("approved", false))
    throw Fault("not_authorized",
                "Trusted main-task application approval required");
  if (mutation) {
    if (!isolatedInput && !nativeInputNeutral()) throw Fault("foreground_required", "Release physical keys and mouse buttons before foreground input");
    if (!hasNativeStopMonitor())
      throw Fault("stop_monitor_unavailable",
                  "Native user-stop monitoring is unavailable");
    if (userInterrupted && owner == op.key())
      throw Fault("foreground_required",
                  "User changed focus; continue through the local UI");
    bool newOwner = owner.empty();
    acquire(op);
    if (newOwner)
      userInterrupted = false;
  }
}
Json Engine::handle(const std::string &method, const Json &params,
                    const Operation &op) {
  auto input = params.value("input", Json::object());
  if (params.contains("presentation")) configureControlFeedback(params["presentation"]);
  if (method == "presentation") return {{"status", "configured"}};
  if (method == "ping" || method == "capabilities") return capabilities();
  if (method == "permission_status")
    return {{"platform", "win32"},
            {"grant_owner", "zcode-computer-control.exe"},
            {"owner", {{"display_name", "ZCode Computer Use"}}},
            {"accessibility", interactiveDesktop() && automation.Get() ? "granted" : "denied"},
            {"screen_recording", interactiveDesktop() && captureSupported() ? "granted" : "denied"},
            {"capabilities", capabilities()},
            {"interactiveDesktop", interactiveDesktop()},
            {"protocolVersion", "zcode-cua/1"}};
  if (method == "list_apps") {
    Json apps = Json::array();
    std::set<DWORD> seen;
    for (auto &window : windows({}))
      if (seen.insert(window.pid).second)
        apps.push_back(descriptor({{"pid", window.pid}}));
    return {{"apps", apps}};
  }
  if (method == "resolve_application")
    return descriptor(input);
  if (method == "stop" || method == "release") {
    clearControlFeedback(op.key());
    if (method == "stop") {
      std::lock_guard<std::mutex> lock(stateMutex);
      stopped.insert(op.key());
    }
    if (owner == op.key()) {
      if (!cleanupInput())
        throw Fault("stop_unconfirmed",
                    "Native input cleanup could not be confirmed",
                    {{"outcome", "unknown"}});
      release(op.key());
    }
    if (method == "release" && params.value("ended", false)) {
      std::lock_guard<std::mutex> lock(stateMutex);
      stopped.erase(op.key());
    }
    for (auto it = observations.begin(); it != observations.end();) {
      if (it->first.rfind(op.key(), 0) == 0)
        it = observations.erase(it);
      else
        ++it;
    }
    return {{"status", method == "stop" ? "stopped" : "closed"}};
  }
  if (method == "resume") {
    if (!params.value("approved", false))
      throw Fault("not_authorized", "Trusted local UI continuation required");
    if (nativeStopDispatchPending()) throw Fault("native_recovering", "Native stop cleanup is still pending");
    if (!owner.empty() && owner != op.key())
      throw Fault("device_busy", "Another task owns native input");
    if (!interactiveDesktop() || !cleanupInput())
      throw Fault("stop_unconfirmed",
                  "Native input cleanup could not be confirmed");
    device.acknowledge();
    std::lock_guard<std::mutex> lock(stateMutex);
    stopped.erase(op.key());
    userInterrupted = false;
    for (auto it = observations.begin(); it != observations.end();) {
      if (it->first.rfind(op.key(), 0) == 0)
        it = observations.erase(it);
      else
        ++it;
    }
    return {{"status", "ready"}};
  }
  if (method == "close_target") {
    auto selected = target(input);
    clearControlFeedback(op.key(), selected.id);
    observations.erase(op.key() + ":" + selected.id);
    bool remaining = false;
    for (auto &row : observations)
      if (row.first.rfind(op.key(), 0) == 0)
        remaining = true;
    if (!remaining && owner == op.key()) {
      if (!cleanupInput())
        throw Fault("stop_unconfirmed",
                    "Native input cleanup could not be confirmed",
                    {{"outcome", "unknown"}});
      release(op.key());
    }
    return {{"status", "closed"}};
  }
  if (method == "launch_app") {
    isolatedInput = true;
    qualify(op, params, true);
    return launch(input, op);
  }
  if (method == "list_windows") {
    qualify(op, params, false);
    Json list = Json::array();
    for (auto &window : windows(input))
      list.push_back(window.json());
    return {{"windows", list}};
  }
  if (method == "resolve_target") {
    qualify(op, params, false);
    return target(input).json();
  }
  if (method == "get_state" || method == "preview") {
    qualify(op, params, false);
    auto window = target(input);
    auto state = observe(window, input, op, method == "preview");
    if (method == "get_state") {
      bool paused;
      { std::lock_guard<std::mutex> lock(stateMutex); paused = userInterrupted && owner == op.key(); }
      controlFeedbackPhase(window, op, paused ? "paused" : "observing");
    }
    return state;
  }
  const auto mode = input.value("inputMode", "isolated");
  if (mode != "isolated" && mode != "foreground") throw Fault("invalid_request", "Invalid inputMode");
  isolatedInput = method != "activate" && mode == "isolated";
  qualify(op, params, true);
  acceptedSegments = 0;
  try {
    auto window = target(input);
    controlFeedbackPhase(window, op, "active");
    auto result = action(method, window, input, op);
    controlFeedbackPhase(window, op, "waiting");
    return result;
  } catch (const Fault &error) {
    pauseControlFeedback(op.key());
    const bool cleaned = cleanupInput();
    auto details = error.details;
    details["acceptedSegments"] = acceptedSegments;
    details["cleanupConfirmed"] = cleaned;
    if (!cleaned) {
      // 原生清理未确认时先建立停止栅栏，不让原错误导致模型在同回合继续输入。
      {
        std::lock_guard<std::mutex> lock(stateMutex);
        stopped.insert(op.key());
      }
      userInterrupted = true;
      writeEvent({{"kind", "control-stopped"},
                  {"context", op.context},
                  {"reason", "input-cleanup-unconfirmed"}});
      details["outcome"] = "unknown";
    } else if (acceptedSegments) {
      details["outcome"] = "partial-or-unknown";
    } else if (!details.contains("outcome")) {
      details["outcome"] = "unknown";
    }
    throw Fault(cleaned ? error.code : "stop_unconfirmed", error.what(),
                details);
  } catch (...) {
    if (!cleanupInput()) {
      {
        std::lock_guard<std::mutex> lock(stateMutex);
        stopped.insert(op.key());
      }
      userInterrupted = true;
      writeEvent({{"kind", "control-stopped"},
                  {"context", op.context},
                  {"reason", "input-cleanup-unconfirmed"}});
      throw Fault(
          "stop_unconfirmed", "Native input cleanup could not be confirmed",
          {{"outcome", "unknown"}, {"acceptedSegments", acceptedSegments}});
    }
    throw;
  }
}
