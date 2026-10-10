// Modified by ZCode Feiyu contributors (2026).
#include "Control.hpp"
#include <deque>
#include <iostream>
#include <winrt/base.h>
int wmain(int argc, wchar_t **argv) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  winrt::init_apartment(winrt::apartment_type::multi_threaded);
  if (argc > 1 && std::wstring(argv[1]) == L"--preflight") {
    bool active = interactiveDesktop();
    Engine probe;
    auto capabilities = probe.capabilities();
    std::cout << Json({{"platform", "win32"},
                       {"grant_owner", "zcode-computer-control.exe"},
                       {"owner", {{"display_name", "ZCode Computer Use"}}},
                       {"accessibility", active && capabilities["structure"].get<bool>() ? "granted" : "denied"},
                       {"screen_recording", active && capabilities["capture"].get<bool>() ? "granted" : "denied"},
                       {"capabilities", capabilities},
                       {"interactiveDesktop", active},
                       {"protocolVersion", "zcode-cua/1"}})
                     .dump();
    return 0;
  }
  Engine engine;
  installStopMonitor();
  std::mutex queueMutex;
  std::condition_variable condition;
  std::deque<Json> queue;
  std::thread reader([&] {
    std::string line;
    char value;
    while (std::cin.get(value)) {
      if (value != '\n') {
        if (line.size() >= 1048576)
          break;
        line += value;
        continue;
      }
      try {
        auto body = Json::parse(line);
        line.clear();
        if (body.value("protocol", "") != "zcode-cua/1" ||
            !body.contains("id") || !body["id"].is_string())
          continue;
        auto method = body.value("method", "");
        if (method == "cancel") {
          std::lock_guard<std::mutex> lock(stateMutex);
          if (cancelled.size() < 512)
            cancelled.insert(body["params"].value("requestId", ""));
          writeReply(body["id"], {{"status", "cancelled"}});
          continue;
        }
        if (method == "stop") {
          std::lock_guard<std::mutex> lock(stateMutex);
          auto context = body["params"].value("context", Json::object());
          stopped.insert(Json::array({context.value("workspaceKey", ""),
                                      context.value("sessionId", ""),
                                      context.value("turnId", "")})
                             .dump());
        }
        std::lock_guard<std::mutex> lock(queueMutex);
        if (queue.size() >= 32) {
          writeReply(
              body["id"],
              {{"code", "busy"}, {"message", "Native operation queue is full"}},
              false);
          continue;
        }
        if (method == "stop" || method == "release")
          queue.push_front(body);
        else
          queue.push_back(body);
        condition.notify_one();
      } catch (...) {
        line.clear();
      }
    }
    quitting = true;
    cleanupInput();
    condition.notify_one();
  });
  while (!quitting) {
    Json body;
    {
      std::unique_lock<std::mutex> lock(queueMutex);
      condition.wait(lock, [&] { return quitting || !queue.empty(); });
      if (quitting)
        break;
      body = queue.front();
      queue.pop_front();
    }
    auto id = body["id"].get<std::string>();
    // 字段转换亦属于当前请求：非法 deadline/context 不能逃出异常边界终止
    // worker。
    try {
      auto params = body.value("params", Json::object());
      if (!params.is_object())
        throw Fault("invalid_request", "Parameters must be an object");
      auto duration = number(params, "deadlineMs", 30000);
      if (duration <= 0 || duration > 120000)
        throw Fault("invalid_request", "Invalid deadline");
      auto context = params.value("context", Json::object());
      if (!context.is_object())
        throw Fault("invalid_request", "Context must be an object");
      const auto method = body.value("method", "");
      const bool mutation = method != "get_state" && method != "preview" && method != "list_windows" && method != "resolve_target";
      Operation operation{id, context, GetTickCount64() + (ULONGLONG)duration,
                          params.value("authorizationGate", Json::object()),
                          params.value("application", Json::object()), mutation};
      writeReply(id,
                 engine.handle(body.value("method", ""), params, operation));
    } catch (const Fault &failure) {
      writeReply(id,
                 {{"code", failure.code},
                  {"message", failure.what()},
                  {"details", failure.details}},
                 false);
    } catch (const winrt::hresult_error &failure) {
      writeReply(id,
                 {{"code", "native_error"},
                  {"message", winrt::to_string(failure.message())},
                  {"details", {{"outcome", "unknown"}}}},
                 false);
    } catch (const std::exception &failure) {
      writeReply(id, {{"code", "invalid_request"}, {"message", failure.what()}},
                 false);
    }
    {
      std::lock_guard<std::mutex> lock(stateMutex);
      cancelled.erase(id);
    }
  }
  try {
    if (cleanupInput())
      engine.release();
    else
      engine.abandon();
  } catch (...) {
    engine.abandon();
  }
  stopMonitor();
  if (reader.joinable())
    reader.join();
  return 0;
}
