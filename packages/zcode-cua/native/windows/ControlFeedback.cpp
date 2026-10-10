// Modified by ZCode Feiyu contributors (2026).
#include "Control.hpp"
#include "FeedbackMotion.hpp"
#include <gdiplus.h>
#include <future>
#include <memory>
using namespace Gdiplus;
namespace {
struct FeedbackStyle {
  float caption = 13; // 默认 text-ui-caption，当前 UI 会传入计算后的 token。
  Color foreground{255, 38, 38, 38}, background{255, 255, 255, 255},
      border{26, 13, 13, 13}, accent{255, 0, 0, 0};
  std::map<std::string, std::wstring> labels{{"observing", L"Observing"}, {"active", L"Controlling"}, {"waiting", L"Waiting"}, {"paused", L"Paused"}};
};
struct FeedbackBinding {
  std::string key;
  Target target;
  std::string phase = "observing";
  HWND badge = nullptr;
  RECT frame{};
  Json gate, application;
  unsigned long long revision = 0;
};
std::mutex feedbackMutex;
std::map<std::string, FeedbackBinding> feedbackBindings;
FeedbackStyle feedbackStyle;
std::thread feedbackThread;
DWORD feedbackThreadId = 0;
HWND feedbackMessage = nullptr, pointerWindow = nullptr, dpiProbeWindow = nullptr;
std::string pointerBinding;
POINT pointerPoint{};
bool pointerKnown = false, pointerPressed = false, pointerAttached = true;
ULONGLONG pointerPressedUntil = 0, pointerMotionStarted = 0;
FeedbackPoint pointerFrom{}, pointerTo{};
unsigned long long feedbackRevision = 0;
ULONG_PTR graphicsToken = 0;
std::set<HWND> feedbackWindows;
std::atomic<bool> feedbackRunning{false};
constexpr UINT RefreshMessage = WM_APP + 13;
UINT feedbackDpi(const Target &target) {
  RECT frame{};
  // 用同显示器内隐藏的 per-monitor-aware 窗口探测，不受目标应用 DPI-unaware 虚拟化影响。
  if (!dpiProbeWindow || !GetWindowRect(target.hwnd, &frame) ||
      !SetWindowPos(dpiProbeWindow, nullptr, frame.left, frame.top, 1, 1, SWP_NOACTIVATE | SWP_NOZORDER)) return 96;
  auto dpi = GetDpiForWindow(dpiProbeWindow);
  return dpi ? dpi : 96;
}
LRESULT CALLBACK feedbackWindowProc(HWND window, UINT message, WPARAM value, LPARAM data) {
  if (message == WM_NCHITTEST) return HTTRANSPARENT;
  if (message == WM_MOUSEACTIVATE) return MA_NOACTIVATE;
  return DefWindowProcW(window, message, value, data);
}
HWND createOverlay() {
  HWND window = CreateWindowExW(WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, L"ZCodeNativeControlFeedback", L"", WS_POPUP | WS_DISABLED, 0, 0, 1, 1, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!window) throw Fault("feedback_unavailable", "Native feedback window could not be created");
  // 此窗口不进入模型 WGC 图像，且点击穿透；不能污染目标发现或输入命中。
  if (!SetWindowDisplayAffinity(window, WDA_EXCLUDEFROMCAPTURE)) {
    DestroyWindow(window);
    throw Fault("feedback_unavailable", "Native feedback capture exclusion failed");
  }
  feedbackWindows.insert(window);
  return window;
}
void renderOverlay(HWND window, const RECT &frame, const FeedbackBinding &binding, bool pointer) {
  const auto dpi = feedbackDpi(binding.target);
  const float scale = (dpi ? dpi : 96) / 96.0f;
  int width = frame.right - frame.left, height = frame.bottom - frame.top;
  if (width < 1 || height < 1) return;
  Bitmap bitmap(width, height, PixelFormat32bppPARGB);
  Graphics graphics(&bitmap);
  graphics.Clear(Color(0, 0, 0, 0));
  graphics.SetSmoothingMode(SmoothingModeAntiAlias);
  graphics.ScaleTransform(scale, scale);
  SolidBrush background(feedbackStyle.background), foreground(feedbackStyle.foreground), accent(feedbackStyle.accent);
  Pen border(feedbackStyle.border, 1), outline(feedbackStyle.background, 3);
  Font font(L"Segoe UI", feedbackStyle.caption, FontStyleRegular, UnitPixel);
  if (pointer) {
    PointF points[]{{3, 3}, {3, 25}, {9, 19}, {14, 31}, {20, 28}, {14, 17}, {24, 17}};
    GraphicsPath path; path.AddPolygon(points, 7);
    graphics.DrawPath(&outline, &path); graphics.FillPath(&accent, &path);
    const bool visiblePress = pointerPressed || GetTickCount64() < pointerPressedUntil;
    graphics.FillEllipse(&background, 21.0f, 22.0f, visiblePress ? 15.0f : 12.0f, visiblePress ? 15.0f : 12.0f);
    Pen ring(feedbackStyle.accent, 1.5f); graphics.DrawEllipse(&ring, 21.0f, 22.0f, 12.0f, 12.0f);
    Font label(L"Segoe UI", std::max(8.0f, feedbackStyle.caption - 3), FontStyleBold, UnitPixel);
    if (binding.phase == "waiting") { Pen spin(feedbackStyle.accent, 1.2f); graphics.DrawArc(&spin, 24.0f, 25.0f, 6.0f, 6.0f, float(GetTickCount64() % 1000) * 0.36f, 250.0f); }
    else if (binding.phase == "paused") { graphics.FillRectangle(&foreground, 24.0f, 25.0f, 2.0f, 6.0f); graphics.FillRectangle(&foreground, 28.0f, 25.0f, 2.0f, 6.0f); }
    else graphics.DrawString(L"Z", 1, &label, PointF(23.5f, 22), &foreground);
  } else {
    const float w = width / scale, h = height / scale;
    GraphicsPath path;
    path.AddArc(0.5f, 0.5f, 12.0f, 12.0f, 180.0f, 90.0f); path.AddArc(w - 12.5f, 0.5f, 12.0f, 12.0f, 270.0f, 90.0f);
    path.AddArc(w - 12.5f, h - 12.5f, 12.0f, 12.0f, 0.0f, 90.0f); path.AddArc(0.5f, h - 12.5f, 12.0f, 12.0f, 90.0f, 90.0f); path.CloseFigure();
    graphics.FillPath(&background, &path); graphics.DrawPath(&border, &path);
    Pen icon(feedbackStyle.accent, 1.2f);
    graphics.DrawRectangle(&icon, 8.0f, 7.0f, 12.0f, 9.0f); graphics.DrawLine(&icon, 14.0f, 16.0f, 14.0f, 19.0f); graphics.DrawLine(&icon, 10.0f, 19.0f, 18.0f, 19.0f);
    auto text = L"ZCode · " + feedbackStyle.labels.at(binding.phase);
    graphics.SetTextRenderingHint(TextRenderingHintAntiAliasGridFit);
    graphics.DrawString(text.c_str(), (INT)text.size(), &font, RectF(27, (h - feedbackStyle.caption - 4) / 2, w - 48, h), nullptr, &foreground);
    if (binding.phase == "waiting" || binding.phase == "active") {
      const float angle = float(GetTickCount64() % 1000) * 0.36f;
      graphics.DrawArc(&icon, w - 15.0f, h / 2 - 3.0f, 6.0f, 6.0f, angle, 250.0f);
    } else if (binding.phase == "paused") {
      graphics.FillRectangle(&foreground, w - 14.0f, 9.0f, 2.0f, 8.0f); graphics.FillRectangle(&foreground, w - 10.0f, 9.0f, 2.0f, 8.0f);
    }
  }
  HBITMAP handle = nullptr;
  if (bitmap.GetHBITMAP(Color(0, 0, 0, 0), &handle) != Ok) return;
  HDC screen = GetDC(nullptr), memory = CreateCompatibleDC(screen);
  auto previous = SelectObject(memory, handle);
  POINT origin{frame.left, frame.top}, source{}; SIZE size{width, height};
  BLENDFUNCTION blend{AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
  bool accepted = UpdateLayeredWindow(window, screen, &origin, &size, memory, &source, 0, &blend, ULW_ALPHA) != FALSE;
  SelectObject(memory, previous); DeleteObject(handle); DeleteDC(memory); ReleaseDC(nullptr, screen);
  if (accepted) {
    // 原生窗口只跟随受控目标的层级，不浮在用户正在使用的其他应用上方。
    const bool topmost = (GetWindowLongPtrW(binding.target.hwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
    SetWindowPos(window, topmost ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    HWND above = GetWindow(binding.target.hwnd, GW_HWNDPREV);
    while (above && feedbackWindows.count(above)) above = GetWindow(above, GW_HWNDPREV);
    SetWindowPos(window, above ? above : HWND_TOP, frame.left, frame.top, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
  }
  else ShowWindow(window, SW_HIDE);
}
void clearPointer() { pointerKnown = false; pointerBinding.clear(); pointerPressed = false; pointerPressedUntil = 0; pointerMotionStarted = 0; if (pointerWindow) ShowWindow(pointerWindow, SW_HIDE); }
void refreshFeedback() {
  std::lock_guard<std::mutex> lock(feedbackMutex);
  std::map<std::string, std::string> displayed;
  for (const auto &[id, binding] : feedbackBindings) {
    auto current = displayed.find(binding.target.id);
    if (current != displayed.end() && (current->second == pointerBinding || (id != pointerBinding && feedbackBindings.at(current->second).revision > binding.revision))) continue;
    displayed[binding.target.id] = id;
  }
  for (auto it = feedbackBindings.begin(); it != feedbackBindings.end();) {
    auto &binding = it->second;
    DWORD pid = 0; GetWindowThreadProcessId(binding.target.hwnd, &pid);
    bool authorized = true; try { checkNativeAuthorization(binding.gate, binding.application); } catch (...) { authorized = false; }
    bool live = false; try { live = binding.target.id == incarnation(pid) + ":" + std::to_string((uintptr_t)binding.target.hwnd) + ":" + windowGeneration(binding.target.hwnd); } catch (...) {}
    if (!authorized || !interactiveDesktop() || !IsWindow(binding.target.hwnd) || pid != binding.target.pid || !live) {
      if (pointerBinding == it->first) clearPointer();
      if (binding.badge) { feedbackWindows.erase(binding.badge); DestroyWindow(binding.badge); }
      it = feedbackBindings.erase(it); continue;
    }
    RECT frame{}; int cloaked = 0; DwmGetWindowAttribute(binding.target.hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked));
    if (cloaked || !IsWindowVisible(binding.target.hwnd) || IsIconic(binding.target.hwnd) || !GetWindowRect(binding.target.hwnd, &frame)) { if (binding.badge) ShowWindow(binding.badge, SW_HIDE); ++it; continue; }
    DwmGetWindowAttribute(binding.target.hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &frame, sizeof(frame));
    if (pointerBinding == it->first && pointerKnown) {
      const LONG dx = frame.left - binding.frame.left, dy = frame.top - binding.frame.top;
      pointerPoint.x += dx; pointerPoint.y += dy; pointerFrom.x += dx; pointerFrom.y += dy; pointerTo.x += dx; pointerTo.y += dy;
    }
    binding.frame = frame;
    if (displayed[binding.target.id] != it->first) { if (binding.badge) ShowWindow(binding.badge, SW_HIDE); ++it; continue; }
    if (!binding.badge) { try { binding.badge = createOverlay(); } catch (...) { ++it; continue; } }
    const float scale = feedbackDpi(binding.target) / 96.0f;
    RECT rectangle{binding.frame.left + (LONG)(32 * scale), binding.frame.top + (LONG)(4 * scale), binding.frame.left + (LONG)(234 * scale), binding.frame.top + (LONG)((std::max(26.0f, feedbackStyle.caption + 13) + 4) * scale)};
    if (rectangle.right > binding.frame.right || rectangle.bottom > binding.frame.bottom) ShowWindow(binding.badge, SW_HIDE);
    else renderOverlay(binding.badge, rectangle, binding, false);
    if (pointerBinding == it->first && pointerAttached) pointerPoint = {rectangle.left - (LONG)(24 * scale), rectangle.bottom + (LONG)(9 * scale)};
    ++it;
  }
  auto pointer = feedbackBindings.find(pointerBinding);
  if (pointerKnown && pointer != feedbackBindings.end() && pointerMotionStarted && pointer->second.phase != "paused") {
    const auto progress = (GetTickCount64() - pointerMotionStarted) / 180.0;
    const auto location = feedbackMotion(pointerFrom, pointerTo, progress);
    pointerPoint = {(LONG)std::lround(location.x), (LONG)std::lround(location.y)};
    if (progress >= 1) pointerMotionStarted = 0;
  }
  if (pointerKnown && pointer != feedbackBindings.end() && pointer->second.badge && IsWindowVisible(pointer->second.badge) && PtInRect(&pointer->second.frame, pointerPoint)) {
    if (!pointerWindow) { try { pointerWindow = createOverlay(); } catch (...) { return; } }
    const auto scale = feedbackDpi(pointer->second.target) / 96.0f;
    RECT rectangle{pointerPoint.x - (LONG)(3 * scale), pointerPoint.y - (LONG)(3 * scale), pointerPoint.x + (LONG)(37 * scale), pointerPoint.y + (LONG)(39 * scale)};
    renderOverlay(pointerWindow, rectangle, pointer->second, true);
  } else if (pointerWindow) ShowWindow(pointerWindow, SW_HIDE);
}
LRESULT CALLBACK messageProc(HWND window, UINT message, WPARAM value, LPARAM data) {
  if (message == RefreshMessage || message == WM_TIMER) { refreshFeedback(); return 0; }
  return DefWindowProcW(window, message, value, data);
}
void ensureFeedback() {
  if (feedbackRunning) return;
  std::promise<bool> ready; auto future = ready.get_future();
  feedbackThread = std::thread([&ready] {
    feedbackThreadId = GetCurrentThreadId();
    SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    GdiplusStartupInput config;
    if (GdiplusStartup(&graphicsToken, &config, nullptr) != Ok) { ready.set_value(false); return; }
    WNDCLASSW overlay{}; overlay.lpfnWndProc = feedbackWindowProc; overlay.hInstance = GetModuleHandleW(nullptr); overlay.lpszClassName = L"ZCodeNativeControlFeedback"; RegisterClassW(&overlay);
    WNDCLASSW message{}; message.lpfnWndProc = messageProc; message.hInstance = GetModuleHandleW(nullptr); message.lpszClassName = L"ZCodeNativeFeedbackOwner"; RegisterClassW(&message);
    feedbackMessage = CreateWindowW(message.lpszClassName, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, message.hInstance, nullptr);
    dpiProbeWindow = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, overlay.lpszClassName, L"", WS_POPUP | WS_DISABLED, 0, 0, 1, 1, nullptr, nullptr, overlay.hInstance, nullptr);
    feedbackRunning = feedbackMessage && dpiProbeWindow; ready.set_value(feedbackRunning);
    if (feedbackRunning) {
      SetTimer(feedbackMessage, 1, 33, nullptr);
      MSG event; while (GetMessageW(&event, nullptr, 0, 0) > 0) { TranslateMessage(&event); DispatchMessageW(&event); }
      KillTimer(feedbackMessage, 1);
    }
    if (dpiProbeWindow) DestroyWindow(dpiProbeWindow);
    if (feedbackMessage) DestroyWindow(feedbackMessage);
    dpiProbeWindow = nullptr;
    std::lock_guard<std::mutex> lock(feedbackMutex);
    for (HWND window : feedbackWindows) DestroyWindow(window);
    feedbackWindows.clear(); feedbackBindings.clear(); clearPointer(); pointerWindow = nullptr; feedbackMessage = nullptr;
    GdiplusShutdown(graphicsToken); feedbackRunning = false;
  });
  if (!future.get()) { if (feedbackThread.joinable()) feedbackThread.join(); throw Fault("feedback_unavailable", "Native graphics feedback could not start"); }
}
}
void configureControlFeedback(const Json &value) {
  if (!value.is_object() || value.size() != 6) throw Fault("invalid_request", "Invalid native presentation");
  FeedbackStyle style; style.caption = (float)number(value, "captionSize");
  if (style.caption < 8 || style.caption > 32) throw Fault("invalid_request", "Invalid caption token");
  auto color = [&](const char *key) { const auto &items = value.at(key); if (!items.is_array() || items.size() != 4) throw Fault("invalid_request", "Invalid color token"); BYTE rgba[4]; for (size_t i = 0; i < 4; i++) { if (!items[i].is_number()) throw Fault("invalid_request", "Invalid color token"); auto n = items[i].get<double>(); if (!std::isfinite(n) || n < 0 || n > 1) throw Fault("invalid_request", "Invalid color range"); rgba[i] = (BYTE)std::lround(n * 255); } return Color(rgba[3], rgba[0], rgba[1], rgba[2]); };
  style.foreground = color("foreground"); style.background = color("background"); style.border = color("border"); style.accent = color("accent");
  const auto &labels = value.at("labels"); if (!labels.is_object() || labels.size() != 4) throw Fault("invalid_request", "Invalid feedback labels");
  for (auto &[phase, label] : style.labels) { label = wide(text(labels, phase.c_str(), 320)); if (label.empty() || label.size() > 80 || std::all_of(label.begin(), label.end(), [](wchar_t c) { return iswspace(c); })) throw Fault("invalid_request", "Invalid feedback label"); }
  std::lock_guard<std::mutex> lock(feedbackMutex); feedbackStyle = std::move(style);
}
void controlFeedbackPhase(const Target &target, const Operation &op, const std::string &phase) {
  if (phase != "observing" && phase != "active" && phase != "waiting" && phase != "paused") throw Fault("invalid_request", "Invalid feedback phase");
  ensureFeedback();
  { std::lock_guard<std::mutex> lock(feedbackMutex); auto id = op.key() + ":" + target.id; auto found = feedbackBindings.find(id); if (found == feedbackBindings.end()) { if (feedbackBindings.size() >= 32) throw Fault("observation_limit", "Native feedback targets exceed limit"); FeedbackBinding binding; binding.key = op.key(); binding.target = target; binding.frame = target.bounds; binding.gate = op.authorizationGate; binding.application = op.application; found = feedbackBindings.emplace(id, std::move(binding)).first; } found->second.phase = phase; found->second.revision = ++feedbackRevision;
    // 观察/语义/等待也创建附着身份，坐标操作开始后才离开附着位置。
    if (phase != "active" || !pointerKnown) { pointerBinding = id; pointerKnown = true; pointerAttached = true; pointerPressed = false; pointerPressedUntil = 0; pointerMotionStarted = 0; }
  }
  PostMessageW(feedbackMessage, RefreshMessage, 0, 0);
}
void controlFeedbackPointer(const Target &target, const Operation &op, POINT point, bool pressed) {
  std::lock_guard<std::mutex> lock(feedbackMutex);
  auto id = op.key() + ":" + target.id;
  if (!feedbackBindings.count(id)) return;
  if (pointerKnown && pointerBinding == id && !pressed && !pointerPressed && (point.x != pointerPoint.x || point.y != pointerPoint.y)) {
    pointerFrom = {(double)pointerPoint.x, (double)pointerPoint.y}; pointerTo = {(double)point.x, (double)point.y}; pointerMotionStarted = GetTickCount64();
  } else { pointerPoint = point; pointerMotionStarted = 0; }
  pointerBinding = id; pointerKnown = true; pointerAttached = false; pointerPressed = pressed;
  if (pressed) pointerPressedUntil = GetTickCount64() + 120;
}
void clearControlFeedback(const std::string &key, const std::string &targetId) {
  std::lock_guard<std::mutex> lock(feedbackMutex);
  // 窗口只能由绘制线程销毁；删除业务显示引用后把像素隐藏，并交给线程退出/刷新回收。
  for (auto it = feedbackBindings.begin(); it != feedbackBindings.end();) {
    if ((key.empty() || it->second.key == key) && (targetId.empty() || it->second.target.id == targetId)) {
      if (pointerBinding == it->first) clearPointer();
      if (it->second.badge) { ShowWindow(it->second.badge, SW_HIDE); PostMessageW(it->second.badge, WM_CLOSE, 0, 0); feedbackWindows.erase(it->second.badge); }
      it = feedbackBindings.erase(it);
    } else ++it;
  }
}
void pauseControlFeedback(const std::string &key) {
  std::lock_guard<std::mutex> lock(feedbackMutex); pointerPressed = false; pointerPressedUntil = 0; pointerMotionStarted = 0;
  for (auto &[id, binding] : feedbackBindings) if (binding.key == key) binding.phase = "paused";
  auto found = feedbackBindings.find(pointerBinding);
  if (found != feedbackBindings.end() && found->second.key == key) pointerAttached = true;
}
void shutdownControlFeedback() {
  if (feedbackThread.joinable()) { PostThreadMessageW(feedbackThreadId, WM_QUIT, 0, 0); feedbackThread.join(); }
}
// WindowFromPoint 跳过禁用的反馈覆盖层；低级 hook 不进入绘制线程的互斥锁。
HWND physicalControlWindowAt(POINT point) { return GetAncestor(WindowFromPoint(point), GA_ROOT); }
