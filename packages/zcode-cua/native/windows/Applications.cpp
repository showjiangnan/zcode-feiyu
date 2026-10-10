// Modified by ZCode Feiyu contributors (2026).
#include "Control.hpp"
#include <cwctype>
#include <filesystem>
#include <shellapi.h>
#include <tlhelp32.h>
std::string processPath(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process)
    throw Fault("target_unavailable", "Cannot inspect target process");
  wchar_t buffer[32768];
  DWORD size = 32768;
  bool ok = QueryFullProcessImageNameW(process, 0, buffer, &size);
  CloseHandle(process);
  if (!ok)
    throw Fault("target_unavailable", "Cannot resolve process executable");
  return utf8(std::wstring(buffer, size));
}
bool containsControlPreview(DWORD pid) {
  auto normalize = [](std::string path) {
    std::transform(
        path.begin(), path.end(), path.begin(),
        [](unsigned char value) { return (char)std::tolower(value); });
    return path;
  };
  static const auto parents = [&] {
    std::set<std::string> paths;
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE)
      throw Fault("policy_unavailable", "Cannot verify control host identity");
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    std::map<DWORD, DWORD> chain;
    if (Process32FirstW(snapshot, &entry))
      do {
        chain[entry.th32ProcessID] = entry.th32ParentProcessID;
      } while (Process32NextW(snapshot, &entry));
    CloseHandle(snapshot);
    DWORD current = GetCurrentProcessId();
    for (int depth = 0; current && depth < 32; depth++) {
      try {
        paths.insert(normalize(processPath(current)));
      } catch (const Fault &) {
      }
      auto next = chain[current];
      if (next == current)
        break;
      current = next;
    }
    return paths;
  }();
  auto path = normalize(processPath(pid));
  auto slash = path.find_last_of("\\/");
  auto name = path.substr(slash == std::string::npos ? 0 : slash + 1);
  // 此判断只暂停自包含 PiP 的预览，不能作为应用访问或输入限制。
  return parents.count(path) || name == "zcode.exe" || name == "zcode preview.exe" ||
         name == "zcode-computer-control.exe";
}
std::string fileIdentity(const std::string &path) {
  HANDLE file =
      CreateFileW(wide(path).c_str(), FILE_READ_ATTRIBUTES,
                  FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                  nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE)
    return "";
  BY_HANDLE_FILE_INFORMATION info{};
  bool ok = GetFileInformationByHandle(file, &info);
  CloseHandle(file);
  return ok ? Json::array({info.dwVolumeSerialNumber, info.nFileIndexHigh,
                           info.nFileIndexLow, info.nFileSizeHigh,
                           info.nFileSizeLow,
                           info.ftLastWriteTime.dwHighDateTime,
                           info.ftLastWriteTime.dwLowDateTime})
                  .dump()
            : "";
}
std::string incarnation(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process)
    throw Fault("target_unavailable", "Process has exited");
  FILETIME created, exited, kernel, user;
  bool ok = GetProcessTimes(process, &created, &exited, &kernel, &user);
  CloseHandle(process);
  if (!ok)
    throw Fault("target_unavailable", "Process identity unavailable");
  return Json::array({pid, created.dwHighDateTime, created.dwLowDateTime,
                      processPath(pid)})
      .dump();
}
DWORD integrityLevel(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid),
         token = nullptr;
  if (!process)
    throw Fault("integrity_unavailable", "Cannot inspect process integrity");
  bool opened = OpenProcessToken(process, TOKEN_QUERY, &token);
  CloseHandle(process);
  if (!opened)
    throw Fault("integrity_unavailable", "Cannot inspect token integrity");
  DWORD size = 0;
  GetTokenInformation(token, TokenIntegrityLevel, nullptr, 0, &size);
  std::vector<BYTE> data(size);
  bool ok =
      GetTokenInformation(token, TokenIntegrityLevel, data.data(), size, &size);
  CloseHandle(token);
  if (!ok)
    throw Fault("integrity_unavailable", "Process integrity unavailable");
  auto label = reinterpret_cast<TOKEN_MANDATORY_LABEL *>(data.data());
  return *GetSidSubAuthority(label->Label.Sid,
                             *GetSidSubAuthorityCount(label->Label.Sid) - 1);
}
Json Target::json() const {
  return {{"targetId", id},
          {"windowId", (uint64_t)(uintptr_t)hwnd},
          {"pid", pid},
          {"appId", processPath(pid)},
          {"appKey", processPath(pid)},
          {"title", title},
          {"frame",
           {{"x", bounds.left},
            {"y", bounds.top},
            {"width", bounds.right - bounds.left},
            {"height", bounds.bottom - bounds.top}}}};
}
std::vector<Target> Engine::windows(const Json &input) {
  struct Search {
    std::vector<Target> result;
    Json input;
  } search{{}, input};
  EnumWindows(
      [](HWND hwnd, LPARAM pointer) -> BOOL {
        auto &search = *reinterpret_cast<Search *>(pointer);
        DWORD pid;
        GetWindowThreadProcessId(hwnd, &pid);
        if (!IsWindowVisible(hwnd) || pid == GetCurrentProcessId())
          return TRUE;
        try {
          const auto &input = search.input;
          std::string path = processPath(pid);
          if (input.contains("pid") && number(input, "pid") != pid)
            return TRUE;
          if (input.contains("appId")) {
            auto selector = wide(text(input, "appId"));
            auto file = std::filesystem::path(wide(path)).filename().wstring();
            if (_wcsicmp(selector.c_str(), wide(path).c_str()) &&
                _wcsicmp(selector.c_str(), file.c_str()))
              return TRUE;
          }
          RECT rect{};
          if (FAILED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS,
                                           &rect, sizeof(rect))) &&
              !GetWindowRect(hwnd, &rect))
            return TRUE;
          if (rect.right <= rect.left || rect.bottom <= rect.top)
            return TRUE;
          int cloaked = 0;
          DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked));
          if (cloaked)
            return TRUE;
          wchar_t title[4096];
          int length = GetWindowTextW(hwnd, title, 4096);
          auto id = incarnation(pid) + ":" + std::to_string((uintptr_t)hwnd) +
                    ":" + windowGeneration(hwnd);
          search.result.push_back(
              {hwnd, pid, rect, id, utf8(std::wstring(title, length))});
        } catch (
            ...) { /* An inaccessible process is not a controllable target. */
        }
        return search.result.size() < 512;
      },
      reinterpret_cast<LPARAM>(&search));
  return search.result;
}
Json Engine::descriptor(const Json &input) {
  auto candidates = windows(input);
  std::set<DWORD> pids;
  for (auto &item : candidates)
    pids.insert(item.pid);
  if (pids.size() > 1)
    throw Fault("ambiguous_target", "Select an exact pid from listApps");
  std::string path;
  DWORD pid = pids.empty() ? 0 : *pids.begin();
  if (pid)
    path = processPath(pid);
  else {
    path = text(input, "appId");
    if (!std::filesystem::path(wide(path)).is_absolute() ||
        std::filesystem::path(wide(path)).extension() != L".exe" ||
        !std::filesystem::is_regular_file(wide(path)))
      throw Fault("target_unavailable",
                  "Select a running app or an absolute executable path");
    path = utf8(std::filesystem::canonical(wide(path)).wstring());
  }
  return {{"appId", path},
          {"appKey", path},
          {"pid", pid},
          {"path", path},
          {"fileIdentity", fileIdentity(path)},
          {"processIncarnation", pid ? incarnation(pid) : ""},
          {"displayName",
           utf8(std::filesystem::path(wide(path)).stem().wstring())}};
}
Target Engine::target(const Json &input) {
  auto candidates = windows(input);
  if (input.contains("windowId")) {
    double value = number(input, "windowId");
    if (value <= 0 || value != std::floor(value) || value > 9007199254740991.0)
      throw Fault("invalid_request", "Invalid windowId");
    auto hwnd = (HWND)(uintptr_t)(uint64_t)value;
    for (auto &item : candidates)
      if (item.hwnd == hwnd) {
        if (input.contains("targetId") && text(input, "targetId") != item.id)
          throw Fault("stale_target", "Window incarnation changed");
        return item;
      }
    throw Fault("target_unavailable", "Window has closed");
  }
  if (input.contains("targetId")) {
    for (auto &item : candidates)
      if (item.id == text(input, "targetId"))
        return item;
    throw Fault("stale_target", "Target identity expired");
  }
  auto foreground = GetForegroundWindow();
  for (auto &item : candidates)
    if (item.hwnd == foreground)
      return item;
  if (candidates.size() != 1)
    throw Fault("ambiguous_window", "Select a windowId from listWindows");
  return candidates[0];
}
Json Engine::launch(const Json &input, const Operation &op) {
  auto app = descriptor(input);
  // 工作区开启时全部应用可访问；系统输入权限和实际目标身份由后续原生检查决定。
  if (app["pid"].get<DWORD>() != 0) {
    Json list = Json::array();
    for (const auto &window : windows(input))
      list.push_back(window.json());
    app["windows"] = list;
    return app;
  }
  auto path = wide(app["path"].get<std::string>());
  SHELLEXECUTEINFOW info{};
  info.cbSize = sizeof(info);
  info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
  info.lpFile = path.c_str();
  info.nShow = SW_SHOWNOACTIVATE;
  if (!ShellExecuteExW(&info))
    throw Fault("launch_failed", "Application could not launch");
  DWORD pid = info.hProcess ? GetProcessId(info.hProcess) : 0;
  if (info.hProcess)
    CloseHandle(info.hProcess);
  while (true) {
    op.guard();
    auto items = windows({{"appId", app["appId"]}});
    if (!items.empty()) {
      auto running = descriptor({{"pid", pid ? pid : items[0].pid}});
      Json list = Json::array();
      for (const auto &window : items)
        list.push_back(window.json());
      running["windows"] = list;
      return running;
    }
    Sleep(20);
  }
}
