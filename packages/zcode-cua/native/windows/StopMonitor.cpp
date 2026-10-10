// Modified by ZCode Feiyu contributors (2026).
#include "Control.hpp"
#include <future>
#include <cstring>
static HHOOK keyboardHook, mouseHook;
static HWINEVENTHOOK focusHook, windowHook;
static std::thread monitor;
static DWORD monitorThread = 0;
static std::mutex ledgerMutex;
static std::vector<INPUT> cleanupEvents;
static std::vector<INPUT> pendingReleases;
static bool sameInput(const INPUT &left, const INPUT &right) {
  return left.type == right.type &&
         (left.type == INPUT_KEYBOARD
              ? left.ki.wVk == right.ki.wVk &&
                    left.ki.wScan == right.ki.wScan &&
                    (left.ki.dwFlags & KEYEVENTF_UNICODE) ==
                        (right.ki.dwFlags & KEYEVENTF_UNICODE)
              : left.mi.dwFlags == right.mi.dwFlags);
}
static void pruneReleasesUnlocked() {
  pendingReleases.erase(
      std::remove_if(
          pendingReleases.begin(), pendingReleases.end(),
          [](const INPUT &input) {
            if (input.type == INPUT_KEYBOARD) {
              WORD key = input.ki.wVk;
              if (input.ki.dwFlags & KEYEVENTF_UNICODE)
                key = VK_PACKET;
              else if (input.ki.dwFlags & KEYEVENTF_SCANCODE) {
                key = static_cast<WORD>(MapVirtualKeyW(
                    input.ki.wScan |
                        ((input.ki.dwFlags & KEYEVENTF_EXTENDEDKEY) ? 0xe000
                                                                    : 0),
                    MAPVK_VSC_TO_VK_EX));
              }
              return key != 0 && !(GetAsyncKeyState(key) & 0x8000);
            }
            const auto key = input.mi.dwFlags & MOUSEEVENTF_LEFTUP ? VK_LBUTTON
                             : input.mi.dwFlags & MOUSEEVENTF_RIGHTUP
                                 ? VK_RBUTTON
                                 : VK_MBUTTON;
            return !(GetAsyncKeyState(key) & 0x8000);
          }),
      pendingReleases.end());
}
static void submittedRelease(const INPUT &input) {
  pendingReleases.erase(std::remove_if(pendingReleases.begin(),
                                       pendingReleases.end(),
                                       [&](const INPUT &value) {
                                         return sameInput(value, input);
                                       }),
                        pendingReleases.end());
  pendingReleases.push_back(input);
}
static std::mutex windowMutex;
static std::map<HWND, std::string> windowGenerations;
static std::atomic<uint64_t> changeSequence{0};
std::string windowGeneration(HWND window) {
  std::lock_guard<std::mutex> lock(windowMutex);
  auto value = windowGenerations.find(window);
  if (value != windowGenerations.end())
    return value->second;
  if (windowGenerations.size() >= 4096)
    windowGenerations.erase(windowGenerations.begin());
  return windowGenerations.emplace(window, uniqueId()).first->second;
}
bool waitForSettled(const Operation &operation) {
  auto started = GetTickCount64(), stable = started;
  auto revision = changeSequence.load();
  for (;;) {
    operation.guard();
    auto now = GetTickCount64();
    if (revision != changeSequence.load()) {
      revision = changeSequence.load();
      stable = now;
    }
    if (now - stable >= 80)
      return true;
    if (now - started >= 1500)
      return false;
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
}
static void trackInputUnlocked(const std::vector<INPUT> &events) {
  for (auto event : events) {
    if (event.type == INPUT_KEYBOARD) {
      if (event.ki.dwFlags & KEYEVENTF_KEYUP) {
        cleanupEvents.erase(
            std::remove_if(cleanupEvents.begin(), cleanupEvents.end(),
                           [&](INPUT value) {
                             return value.type == INPUT_KEYBOARD &&
                                    value.ki.wVk == event.ki.wVk &&
                                    value.ki.wScan == event.ki.wScan;
                           }),
            cleanupEvents.end());
        submittedRelease(event);
      } else {
        event.ki.dwFlags |= KEYEVENTF_KEYUP;
        cleanupEvents.push_back(event);
      }
    } else if (event.type == INPUT_MOUSE) {
      for (auto pair :
           {std::pair<DWORD, DWORD>{MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP},
            {MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP},
            {MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP}}) {
        if (event.mi.dwFlags & pair.first) {
          event.mi.dwFlags = pair.second;
          cleanupEvents.push_back(event);
        } else if (event.mi.dwFlags & pair.second) {
          cleanupEvents.erase(
              std::remove_if(cleanupEvents.begin(), cleanupEvents.end(),
                             [&](INPUT value) {
                               return value.type == INPUT_MOUSE &&
                                      value.mi.dwFlags == pair.second;
                             }),
              cleanupEvents.end());
          auto release = event;
          release.mi.dwFlags = pair.second;
          submittedRelease(release);
        }
      }
    }
  }
}
UINT sendTrackedInput(const std::vector<INPUT> &events) {
  std::lock_guard<std::mutex> lock(ledgerMutex);
  pruneReleasesUnlocked();
  UINT accepted = SendInput((UINT)events.size(),
                            const_cast<INPUT *>(events.data()), sizeof(INPUT));
  trackInputUnlocked(
      std::vector<INPUT>(events.begin(), events.begin() + accepted));
  return accepted;
}
bool cleanupInput() {
  const bool isolatedClean = cleanupIsolatedInput();
  std::lock_guard<std::mutex> lock(ledgerMutex);
  if (!cleanupEvents.empty()) {
    auto accepted = SendInput((UINT)cleanupEvents.size(), cleanupEvents.data(),
                              sizeof(INPUT));
    auto submitted = std::vector<INPUT>(cleanupEvents.begin(),
                                        cleanupEvents.begin() + accepted);
    cleanupEvents.erase(cleanupEvents.begin(),
                        cleanupEvents.begin() + accepted);
    for (const auto &event : submitted)
      submittedRelease(event);
  }
  // SendInput 接受 up 后仍核对系统状态；未知释放保留账本和设备持久阻断。
  const auto deadline = GetTickCount64() + 50;
  do {
    pruneReleasesUnlocked();
    if (cleanupEvents.empty() && pendingReleases.empty())
      return isolatedClean;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  } while (GetTickCount64() < deadline);
  return false;
}
namespace {
constexpr unsigned PermanentStop = 1u << 16;
std::atomic<unsigned> pendingStop{0};
std::atomic<bool> stopDispatch{false}, monitorAlive{false}, rawRegistered{false}, stopWorkerRunning{false};
HANDLE stopWake = nullptr;
std::thread stopWorker;
const char *stopReasons[] = {"unknown-stop", "target-escape", "target-keyboard", "target-pointer", "foreground-changed", "locked", "target-closed"};
unsigned reasonCode(const char *reason) {
  for (unsigned index = 1; index < std::size(stopReasons); ++index)
    if (std::strcmp(stopReasons[index], reason) == 0) return index;
  return 0;
}
}
bool nativeStopDispatchPending() { return stopDispatch; }
static void interrupt(bool permanent, const char *reason, const char *origin = "native") {
  if (!inputWindow.load() || (!permanent && userInterrupted.exchange(true))) return;
  userInterrupted = true;
  stopDispatch = true;
  const unsigned source = std::strcmp(origin, "external-input") == 0 ? 1 : std::strcmp(origin, "system-or-unclassified") == 0 ? 2 : 0;
  const unsigned next = reasonCode(reason) | (source << 8) | (permanent ? PermanentStop : 0);
  unsigned previous = pendingStop.load();
  // 有限原子邮箱保留永久停止优先级；回调不等输入清理、反馈锁或 stdout。
  while (!(previous & PermanentStop) && !pendingStop.compare_exchange_weak(previous, next)) {}
  if (stopWake) SetEvent(stopWake);
}
static void dispatchStop(unsigned packed) {
  const bool permanent = (packed & PermanentStop) != 0;
  const char *reason = stopReasons[packed & 255];
  const char *origin = (packed >> 8 & 255) == 1 ? "external-input" : (packed >> 8 & 255) == 2 ? "system-or-unclassified" : "native";
  Json context;
  std::string key;
  {
    std::lock_guard<std::mutex> lock(stateMutex);
    context = controlContext;
    if (!context.is_null()) {
      key = Json::array({context.value("workspaceKey", ""), context.value("sessionId", ""), context.value("turnId", "")}).dump();
      if (permanent) stopped.insert(key);
    }
  }
  const bool clean = cleanupInput();
  if (!context.is_null()) {
    if (permanent) clearControlFeedback(key); else pauseControlFeedback(key);
    writeEvent({{"kind", permanent ? "control-stopped" : "control-paused"}, {"context", context},
                {"reason", clean ? reason : "input-cleanup-unconfirmed"}, {"origin", origin}});
  }
}
static LRESULT CALLBACK keyHook(int code, WPARAM message, LPARAM data) {
  if (code >= 0 && (message == WM_KEYDOWN || message == WM_SYSKEYDOWN)) {
    auto event = reinterpret_cast<KBDLLHOOKSTRUCT *>(data);
    if (event->dwExtraInfo != InputTag && inputWindow.load()) {
      // 其他应用中的 Esc 不得中断独立输入；准确目标中的普通输入是可继续的接管。
      const bool own = GetForegroundWindow() == inputWindow.load();
      const auto origin = event->flags & LLKHF_INJECTED ? "external-input" : "system-or-unclassified";
      if (own && event->vkCode == VK_ESCAPE)
        interrupt(true, "target-escape", origin);
      else if (own || !isolatedInput)
        interrupt(false, own ? "target-keyboard" : "foreground-changed", origin);
    }
  }
  return CallNextHookEx(keyboardHook, code, message, data);
}
static LRESULT CALLBACK pointerHook(int code, WPARAM message, LPARAM data) {
  if (code >= 0 && (message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN || message == WM_MBUTTONDOWN || message == WM_XBUTTONDOWN)) {
    auto event = reinterpret_cast<MSLLHOOKSTRUCT *>(data);
    if (event->dwExtraInfo != InputTag && inputWindow.load()) {
      bool own = physicalControlWindowAt(event->pt) == inputWindow.load();
      if (own || !isolatedInput) interrupt(false, own ? "target-pointer" : "foreground-changed", event->flags & LLMHF_INJECTED ? "external-input" : "system-or-unclassified");
    }
  }
  return CallNextHookEx(mouseHook, code, message, data);
}
static LRESULT CALLBACK windowProc(HWND hwnd, UINT message, WPARAM value,
                                   LPARAM data) {
  if (message == WM_INPUT) {
    RAWINPUT input{};
    UINT bytes = sizeof(input);
    if (GetRawInputData(reinterpret_cast<HRAWINPUT>(data), RID_INPUT, &input, &bytes, sizeof(RAWINPUTHEADER)) == bytes && inputWindow.load() && input.header.hDevice) {
      const bool own = GetForegroundWindow() == inputWindow.load();
      if (input.header.dwType == RIM_TYPEKEYBOARD && !(input.data.keyboard.Flags & RI_KEY_BREAK)) {
        if (own && input.data.keyboard.VKey == VK_ESCAPE) interrupt(true, "target-escape");
        else if (own || !isolatedInput) interrupt(false, own ? "target-keyboard" : "foreground-changed");
      } else if (input.header.dwType == RIM_TYPEMOUSE && (input.data.mouse.usButtonFlags & (RI_MOUSE_LEFT_BUTTON_DOWN | RI_MOUSE_RIGHT_BUTTON_DOWN | RI_MOUSE_MIDDLE_BUTTON_DOWN | RI_MOUSE_BUTTON_4_DOWN | RI_MOUSE_BUTTON_5_DOWN))) {
        POINT point{}; GetCursorPos(&point);
        bool target = physicalControlWindowAt(point) == inputWindow.load();
        if (target || !isolatedInput) interrupt(false, target ? "target-pointer" : "foreground-changed");
      }
    }
  }
  if (message == WM_WTSSESSION_CHANGE &&
      (value == WTS_SESSION_LOCK || value == WTS_SESSION_LOGOFF ||
       value == WTS_CONSOLE_DISCONNECT))
    interrupt(true, "locked");
  return DefWindowProcW(hwnd, message, value, data);
}
void installStopMonitor() {
  stopWake = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!stopWake) throw Fault("stop_monitor_unavailable", "Stop dispatch event unavailable");
  stopWorkerRunning = true;
  stopWorker = std::thread([] {
    while (stopWorkerRunning) {
      WaitForSingleObject(stopWake, INFINITE);
      while (auto packed = pendingStop.exchange(0)) {
        try { dispatchStop(packed); } catch (...) { userInterrupted = true; }
      }
      stopDispatch = false;
      // 与末次 exchange 竞态的新事件必须保留围栏并再次唤醒。
      if (pendingStop.load()) { stopDispatch = true; SetEvent(stopWake); }
    }
  });
  std::promise<void> ready;
  auto future = ready.get_future();
  monitor = std::thread([&ready] {
    monitorThread = GetCurrentThreadId();
    WNDCLASSW cls{};
    cls.lpfnWndProc = windowProc;
    cls.hInstance = GetModuleHandleW(nullptr);
    cls.lpszClassName = L"ZCodeComputerControlMonitor";
    RegisterClassW(&cls);
    HWND hwnd = CreateWindowW(cls.lpszClassName, L"", 0, 0, 0, 0, 0,
                              HWND_MESSAGE, nullptr, cls.hInstance, nullptr);
    const bool sessionRegistered = hwnd && WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
    RAWINPUTDEVICE devices[]{{1, 6, RIDEV_INPUTSINK, hwnd}, {1, 2, RIDEV_INPUTSINK, hwnd}};
    rawRegistered = hwnd && RegisterRawInputDevices(devices, 2, sizeof(RAWINPUTDEVICE));
    keyboardHook = SetWindowsHookExW(WH_KEYBOARD_LL, keyHook, cls.hInstance, 0);
    mouseHook = SetWindowsHookExW(WH_MOUSE_LL, pointerHook, cls.hInstance, 0);
    focusHook = SetWinEventHook(
        EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, nullptr,
        [](HWINEVENTHOOK, DWORD, HWND foreground, LONG, LONG, DWORD, DWORD) {
          if (!isolatedInput && inputWindow.load() && foreground != inputWindow.load())
            interrupt(false, "foreground-changed");
        },
        0, 0, WINEVENT_OUTOFCONTEXT);
    windowHook = SetWinEventHook(
        EVENT_OBJECT_CREATE, EVENT_OBJECT_TEXTSELECTIONCHANGED, nullptr,
        [](HWINEVENTHOOK, DWORD event, HWND window, LONG object, LONG, DWORD,
           DWORD) {
          changeSequence++;
          if (object != OBJID_WINDOW || !window)
            return;
          if (event == EVENT_OBJECT_CREATE || event == EVENT_OBJECT_DESTROY) {
            {
              std::lock_guard<std::mutex> lock(windowMutex);
              if (windowGenerations.size() >= 4096)
                windowGenerations.erase(windowGenerations.begin());
              windowGenerations[window] = uniqueId();
            }
            if (event == EVENT_OBJECT_DESTROY && inputWindow.load() == window)
              interrupt(true, "target-closed");
          }
        },
        0, 0, WINEVENT_OUTOFCONTEXT);
    monitorAlive = sessionRegistered;
    ready.set_value();
    MSG message;
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
    monitorAlive = false;
    rawRegistered = false;
    RAWINPUTDEVICE remove[]{{1, 6, RIDEV_REMOVE, nullptr}, {1, 2, RIDEV_REMOVE, nullptr}};
    RegisterRawInputDevices(remove, 2, sizeof(RAWINPUTDEVICE));
    if (keyboardHook)
      UnhookWindowsHookEx(keyboardHook);
    if (mouseHook)
      UnhookWindowsHookEx(mouseHook);
    if (focusHook)
      UnhookWinEvent(focusHook);
    if (windowHook)
      UnhookWinEvent(windowHook);
    WTSUnRegisterSessionNotification(hwnd);
    DestroyWindow(hwnd);
  });
  future.get();
}
bool hasNativeStopMonitor() {
  // Raw Input 的独立注册/消息循环是物理接管通道，不以可被静默移除的 hook 句柄当唯一健康依据。
  return monitorAlive && rawRegistered && keyboardHook && mouseHook && focusHook && windowHook;
}
void stopMonitor() {
  if (monitorThread)
    PostThreadMessageW(monitorThread, WM_QUIT, 0, 0);
  if (monitor.joinable())
    monitor.join();
  monitorThread = 0;
  stopWorkerRunning = false;
  if (stopWake) SetEvent(stopWake);
  if (stopWorker.joinable()) stopWorker.join();
  if (stopWake) CloseHandle(stopWake);
  stopWake = nullptr;
}
