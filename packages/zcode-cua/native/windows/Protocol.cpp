// Modified by ZCode Feiyu contributors (2026).
#include "Control.hpp"
#include <filesystem>
#include <objbase.h>
#include <sstream>
std::atomic<bool> quitting{false};
std::mutex stateMutex;
std::set<std::string> cancelled, stopped;
Json controlContext;
std::atomic<HWND> inputWindow{nullptr};
std::atomic<bool> userInterrupted{false};
std::atomic<bool> isolatedInput{true};
static std::mutex outputMutex;
std::wstring wide(const std::string &value) {
  if (value.empty())
    return {};
  int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                   (int)value.size(), nullptr, 0);
  if (!length)
    throw Fault("invalid_utf8", "Text must be valid UTF-8");
  std::wstring out(length, 0);
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                      (int)value.size(), out.data(), length);
  return out;
}
std::string utf8(const std::wstring &value) {
  if (value.empty())
    return {};
  int length =
      WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                          (int)value.size(), nullptr, 0, nullptr, nullptr);
  if (!length)
    return {};
  std::string out(length, 0);
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                      (int)value.size(), out.data(), length, nullptr, nullptr);
  return out;
}
std::string uniqueId() {
  GUID value;
  check(CoCreateGuid(&value), "Could not create identity");
  wchar_t out[40];
  StringFromGUID2(value, out, 40);
  return utf8(out);
}
std::string text(const Json &input, const char *key, size_t limit) {
  if (!input.contains(key) || !input[key].is_string())
    throw Fault("invalid_request", std::string("Invalid ") + key);
  auto value = input[key].get<std::string>();
  if (value.size() > limit || (limit == 4096 && value.empty()))
    throw Fault("invalid_request", std::string("Invalid ") + key);
  return value;
}
double number(const Json &input, const char *key, double fallback) {
  if (!input.contains(key))
    return fallback;
  if (!input[key].is_number() || !std::isfinite(input[key].get<double>()))
    throw Fault("invalid_request", std::string("Invalid ") + key);
  return input[key].get<double>();
}
std::string Operation::key() const {
  return Json::array({context.value("workspaceKey", ""),
                      context.value("sessionId", ""),
                      context.value("turnId", "")})
      .dump();
}
void checkNativeAuthorization(const Json &authorizationGate, const Json &application) {
  if (!authorizationGate.empty()) {
    auto path = wide(text(authorizationGate, "path"));
    auto expected = text(authorizationGate, "epoch");
    std::string epoch = "initial";
    std::ifstream stream(std::filesystem::path(path), std::ios::binary);
    if (stream) {
      stream.seekg(0, std::ios::end);
      auto size = stream.tellg();
      if (size < 0 || size > 4096)
        throw Fault("authorization_unavailable",
                    "Invalid application approval revision");
      stream.seekg(0);
      std::string bytes(static_cast<size_t>(size), '\0');
      if (!stream.read(bytes.data(), static_cast<std::streamsize>(size)))
        throw Fault("authorization_unavailable",
                    "Cannot read application approval revision");
      try {
        auto value = Json::parse(bytes);
        if (value.value("schemaVersion", 0) != 1)
          throw Fault("authorization_unavailable",
                      "Invalid application approval revision");
        epoch = value.at("epoch").get<std::string>();
      } catch (const Json::exception &) {
        throw Fault("authorization_unavailable",
                    "Invalid application approval revision");
      }
    } else {
      SetLastError(0);
      if (GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES ||
          (GetLastError() != ERROR_FILE_NOT_FOUND &&
           GetLastError() != ERROR_PATH_NOT_FOUND))
        throw Fault("authorization_unavailable",
                    "Cannot verify application approval revision");
    }
    if (epoch != expected)
      throw Fault("permission_revoked", "Application approval was revoked",
                  {{"outcome", "partial-or-unknown"}});
  }
  if (application.value("fileIdentity", "") != "" &&
      fileIdentity(application.value("path", "")) !=
          application["fileIdentity"].get<std::string>())
    throw Fault("application_changed",
                "Approved application executable changed");
  if (application.value("pid", 0u) != 0 &&
      incarnation(application["pid"].get<DWORD>()) !=
          application.value("processIncarnation", ""))
    throw Fault("application_changed", "Approved application process changed");
}
void Operation::guard() const {
  checkNativeAuthorization(authorizationGate, application);
  std::lock_guard<std::mutex> lock(stateMutex);
  if (quitting || cancelled.count(id))
    throw Fault("cancelled", "Native operation cancelled");
  if (stopped.count(key()))
    throw Fault("turn_stopped", "Computer control was stopped");
  // hook 立即设围栏，清理/事件异步完成之前不能执行下一段输入或承认新 owner。
  if (mutation && (nativeStopDispatchPending() || (userInterrupted && controlContext == context)))
    throw Fault("foreground_required", "Native user takeover requires local continuation");
  if (GetTickCount64() >= deadline)
    throw Fault("deadline", "Native operation deadline exceeded");
  if (!interactiveDesktop())
    throw Fault("locked", "Interactive Windows desktop is unavailable");
}
bool interactiveDesktop() {
  HDESK desktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
  if (!desktop)
    return false;
  wchar_t name[128];
  DWORD length = 0;
  bool active = GetUserObjectInformationW(desktop, UOI_NAME, name, sizeof(name),
                                          &length) &&
                _wcsicmp(name, L"Default") == 0;
  CloseDesktop(desktop);
  return active;
}
void writeReply(const std::string &id, const Json &result, bool ok) {
  Json reply = {{"protocol", "zcode-cua/1"},
                {"id", id},
                {"ok", ok},
                {ok ? "result" : "error", result}};
  auto line = reply.dump();
  if (line.size() > 33554432)
    line = Json({{"protocol", "zcode-cua/1"},
                 {"id", id},
                 {"ok", false},
                 {"error",
                  {{"code", "response_too_large"},
                   {"message", "Native response exceeded its limit"}}}})
               .dump();
  std::lock_guard<std::mutex> lock(outputMutex);
  std::cout << line << std::endl;
}
void writeEvent(const Json &event) {
  std::lock_guard<std::mutex> lock(outputMutex);
  std::cout << Json({{"protocol", "zcode-cua/1"},
                     {"id", "native-event"},
                     {"event", event}})
                   .dump()
            << std::endl;
}
