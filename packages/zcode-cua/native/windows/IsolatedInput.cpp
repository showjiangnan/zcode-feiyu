// Modified by ZCode Feiyu contributors (2026).
#include "Control.hpp"
#include <windowsx.h>
namespace {
struct MessageRelease { HWND child; Target root; std::string generation; UINT message; WPARAM value; LPARAM point; };
std::mutex messageMutex;
std::vector<MessageRelease> releases;
void dispatchTarget(const Target &target, HWND child, UINT message, WPARAM value, LPARAM position, const Operation &op, UINT release = 0) {
  op.guard();
  DWORD pid = 0; GetWindowThreadProcessId(child, &pid);
  if (pid != target.pid || !IsWindow(child) || GetAncestor(child, GA_ROOT) != target.hwnd) throw Fault("stale_target", "Isolated input child no longer belongs to the bound window");
  // down 超时也可能已执行，必须在调用前登记；PostMessage 成功并不证明窗口处理了 up。
  if (release) {
    std::lock_guard<std::mutex> lock(messageMutex);
    releases.push_back({child, target, windowGeneration(child), release, message == WM_KEYDOWN ? value : 0, position});
  }
  DWORD_PTR result = 0;
  SetLastError(ERROR_SUCCESS);
  const auto now = GetTickCount64();
  const auto budget = static_cast<UINT>(std::min<ULONGLONG>(250, op.deadline > now ? op.deadline - now : 1));
  if (!SendMessageTimeoutW(child, message, value, position, SMTO_ABORTIFHUNG | SMTO_BLOCK | SMTO_ERRORONEXIT, budget, &result))
    throw Fault("partial_input", "Targeted message processing was not confirmed", {{"win32", GetLastError()}, {"outcome", "partial-or-unknown"}});
  if (message == WM_LBUTTONUP || message == WM_RBUTTONUP || message == WM_MBUTTONUP || message == WM_KEYUP) {
    std::lock_guard<std::mutex> lock(messageMutex);
    releases.erase(std::remove_if(releases.begin(), releases.end(), [&](const auto &entry) { return entry.child == child && entry.message == message; }), releases.end());
  }
}
POINT clientPoint(HWND child, POINT screen) {
  if (!PhysicalToLogicalPointForPerMonitorDPI(child, &screen)) throw Fault("hit_test_unavailable", "Target DPI conversion failed");
  auto previous = SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(child));
  bool mapped = ScreenToClient(child, &screen) != FALSE;
  if (previous) SetThreadDpiAwarenessContext(previous);
  if (!mapped || screen.x < SHRT_MIN || screen.x > SHRT_MAX || screen.y < SHRT_MIN || screen.y > SHRT_MAX) throw Fault("input_mode_unavailable", "Target client coordinate exceeds window-message range");
  return screen;
}
HWND childAt(const Target &target, POINT screen) {
  HWND child = target.hwnd;
  for (int depth = 0; depth < 32; depth++) {
    POINT relative = clientPoint(child, screen);
    auto previous = SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(child));
    RECT rectangle{}; GetClientRect(child, &rectangle);
    HWND next = ChildWindowFromPointEx(child, relative, CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT);
    if (previous) SetThreadDpiAwarenessContext(previous);
    if (!PtInRect(&rectangle, relative)) throw Fault("input_mode_unavailable", "Isolated mouse supports client areas; foreground supports window chrome");
    if (!next || next == child) return child;
    DWORD pid = 0; GetWindowThreadProcessId(next, &pid);
    if (pid != target.pid) throw Fault("stale_target", "Isolated child belongs to another process");
    child = next;
  }
  throw Fault("hit_test_unavailable", "Isolated child hierarchy exceeds limit");
}
HWND textTarget(const Target &target) {
  GUITHREADINFO info{}; info.cbSize = sizeof(info);
  auto thread = GetWindowThreadProcessId(target.hwnd, nullptr);
  if (!GetGUIThreadInfo(thread, &info) || !info.hwndFocus || GetAncestor(info.hwndFocus, GA_ROOT) != target.hwnd) throw Fault("input_mode_unavailable", "No verified background text focus; use semantic values or foreground input");
  wchar_t name[128]{}; GetClassNameW(info.hwndFocus, name, 128);
  std::wstring type(name); std::transform(type.begin(), type.end(), type.begin(), [](wchar_t c) { return (wchar_t)towupper(c); });
  if (type != L"EDIT" && !type.starts_with(L"RICHEDIT")) throw Fault("input_mode_unavailable", "This control requires UIA text semantics or foreground keyboard input");
  if (GetWindowLongPtrW(info.hwndFocus, GWL_STYLE) & ES_PASSWORD) throw Fault("manual_input_required", "Enter protected text manually");
  return info.hwndFocus;
}
}
bool cleanupIsolatedInput() {
  std::lock_guard<std::mutex> lock(messageMutex);
  bool confirmed = true;
  for (auto it = releases.begin(); it != releases.end();) {
    DWORD pid = 0; GetWindowThreadProcessId(it->child, &pid);
    bool live = IsWindow(it->child) && pid == it->root.pid && windowGeneration(it->child) == it->generation && it->root.id == incarnation(pid) + ":" + std::to_string((uintptr_t)it->root.hwnd) + ":" + windowGeneration(it->root.hwnd);
    auto point = it->message == WM_KEYUP ? it->point | (LPARAM(1) << 30) | (LPARAM(1) << 31) : it->point;
    DWORD_PTR result = 0;
    if (!live || SendMessageTimeoutW(it->child, it->message, it->value, point, SMTO_ABORTIFHUNG | SMTO_BLOCK | SMTO_ERRORONEXIT, 250, &result)) it = releases.erase(it);
    else { confirmed = false; ++it; }
  }
  return confirmed;
}
void Engine::isolatedAction(const std::string &method, const Target &target, const Json &input, Observation &observation, const Operation &op) {
  auto submit = [&](HWND child, UINT message, WPARAM value, LPARAM position, UINT release = 0) {
    verifyForeground(target, op); dispatchTarget(target, child, message, value, position, op, release); acceptedSegments++;
  };
  if (method == "type_text" || method == "press_key") {
    HWND child = textTarget(target);
    if (method == "type_text") {
      if (input.value("mode", "unicode") == "clipboard") throw Fault("input_mode_unavailable", "Isolated clipboard shortcuts require semantic values or foreground");
      for (wchar_t unit : wide(text(input, "text", 400000))) submit(child, WM_CHAR, unit, 1);
    } else {
      if (input.contains("scanCode")) throw Fault("input_mode_unavailable", "Physical scan codes require foreground keyboard state");
      auto key = text(input, "key"); std::transform(key.begin(), key.end(), key.begin(), [](unsigned char c) { return (char)std::tolower(c); });
      const std::map<std::string, WORD> keys{{"enter", VK_RETURN}, {"return", VK_RETURN}, {"tab", VK_TAB}, {"backspace", VK_BACK}, {"delete", VK_DELETE}, {"left", VK_LEFT}, {"right", VK_RIGHT}, {"up", VK_UP}, {"down", VK_DOWN}, {"home", VK_HOME}, {"end", VK_END}};
      if (!keys.count(key) || (GetAsyncKeyState(VK_CONTROL) & 0x8000) || (GetAsyncKeyState(VK_SHIFT) & 0x8000) || (GetAsyncKeyState(VK_MENU) & 0x8000)) throw Fault("input_mode_unavailable", "This shortcut requires foreground keyboard state");
      WORD code = keys.at(key); auto scan = MapVirtualKeyExW(code, MAPVK_VK_TO_VSC, GetKeyboardLayout(GetWindowThreadProcessId(child, nullptr)));
      LPARAM value = 1 | (scan << 16); submit(child, WM_KEYDOWN, code, value, WM_KEYUP); submit(child, WM_KEYUP, code, value | (LPARAM(1) << 30) | (LPARAM(1) << 31));
    }
    return;
  }
  int button = (int)number(input, "button");
  if (button < 0 || button > 2 || number(input, "button") != button) throw Fault("invalid_request", "Invalid mouse button");
  const UINT down = button == 0 ? WM_LBUTTONDOWN : button == 1 ? WM_RBUTTONDOWN : WM_MBUTTONDOWN;
  const UINT up = button == 0 ? WM_LBUTTONUP : button == 1 ? WM_RBUTTONUP : WM_MBUTTONUP;
  const UINT twice = button == 0 ? WM_LBUTTONDBLCLK : button == 1 ? WM_RBUTTONDBLCLK : WM_MBUTTONDBLCLK;
  const WPARAM held = button == 0 ? MK_LBUTTON : button == 1 ? MK_RBUTTON : MK_MBUTTON;
  auto move = [&](const Json &value, WPARAM flags = 0) {
    POINT screen = point(target, observation, value); HWND child = childAt(target, screen); POINT client = clientPoint(child, screen);
    submit(child, WM_MOUSEMOVE, flags, MAKELPARAM((SHORT)client.x, (SHORT)client.y)); controlFeedbackPointer(target, op, screen, flags != 0);
    return std::pair<HWND, LPARAM>{child, MAKELPARAM((SHORT)client.x, (SHORT)client.y)};
  };
  if (method == "drag") {
    const auto &path = input.at("path"); if (!path.is_array() || path.size() < 2 || path.size() > 1000) throw Fault("invalid_request", "Invalid drag path");
    auto first = input; first.update(path[0]); auto [child, position] = move(first); submit(child, down, held, position, up);
    POINT screen = point(target, observation, first);
    for (size_t i = 1; i < path.size(); i++) {
      auto next = input; next.update(path[i]); screen = point(target, observation, next); auto client = clientPoint(child, screen);
      // 拖动一直投递给初始接收控件，不能把 up 发送给途经的另一个子窗口。
      position = MAKELPARAM((SHORT)client.x, (SHORT)client.y); submit(child, WM_MOUSEMOVE, held, position); controlFeedbackPointer(target, op, screen, true); std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    submit(child, up, 0, position); controlFeedbackPointer(target, op, screen, false);
  } else {
    auto [child, position] = move(input);
    if (method == "click") {
      int count = (int)number(input, "clickCount", 1); if (count < 1 || count > 3 || number(input, "clickCount", 1) != count) throw Fault("invalid_request", "Invalid click count");
      POINT screen = point(target, observation, input);
      for (int i = 0; i < count; i++) { controlFeedbackPointer(target, op, screen, true); submit(child, i == 1 ? twice : down, held, position, up); submit(child, up, 0, position); controlFeedbackPointer(target, op, screen, false); }
    } else if (method == "scroll") {
      auto delta = wheel(target, input);
      POINT screen = point(target, observation, input);
      if (screen.x < SHRT_MIN || screen.x > SHRT_MAX || screen.y < SHRT_MIN || screen.y > SHRT_MAX) throw Fault("input_mode_unavailable", "Scroll coordinate exceeds window-message range");
      LPARAM location = MAKELPARAM((SHORT)screen.x, (SHORT)screen.y);
      if (delta.y) submit(child, WM_MOUSEWHEEL, MAKEWPARAM(0, (SHORT)-delta.y), location);
      if (delta.x) submit(child, WM_MOUSEHWHEEL, MAKEWPARAM(0, (SHORT)delta.x), location);
    } else if (method != "move") throw Fault("unknown_method", "Unknown isolated input action");
  }
}
