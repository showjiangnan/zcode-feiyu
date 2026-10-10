// Modified by ZCode Feiyu contributors (2026).
#include "Control.hpp"
#include <algorithm>
#include <memory>
static auto automationString(const std::string &text) {
  auto value = wide(text);
  BSTR allocated = SysAllocStringLen(value.data(), (UINT)value.size());
  if (!allocated) throw Fault("native_error", "Cannot allocate automation text");
  return std::unique_ptr<wchar_t, decltype(&SysFreeString)>(allocated, &SysFreeString);
}
static INPUT keyboard(WORD code, bool up, bool unicode = false) {
  INPUT input{};
  input.type = INPUT_KEYBOARD;
  input.ki.wVk = unicode ? 0 : code;
  input.ki.wScan = unicode ? code : 0;
  input.ki.dwFlags =
      (unicode ? KEYEVENTF_UNICODE : 0) | (up ? KEYEVENTF_KEYUP : 0);
  input.ki.dwExtraInfo = InputTag;
  return input;
}
POINT Engine::wheel(const Target &target, const Json &input) {
  const auto key = target.id + (isolatedInput ? ":isolated" : ":foreground");
  if (wheelTarget != key) { wheelTarget = key; wheelX = wheelY = 0; }
  UINT lines = 0, chars = 0;
  if (!SystemParametersInfoW(SPI_GETWHEELSCROLLLINES, 0, &lines, 0) || !SystemParametersInfoW(SPI_GETWHEELSCROLLCHARS, 0, &chars, 0))
    throw Fault("input_mode_unavailable", "System scroll settings unavailable");
  try {
    auto unit = input.value("unit", "pixels");
    double dpi = GetDpiForWindow(target.hwnd);
    return {zcode::input::accumulateWheel(zcode::input::wheelDelta(number(input, "dx"), unit, dpi, target.bounds.right - target.bounds.left, chars), wheelX),
            zcode::input::accumulateWheel(zcode::input::wheelDelta(number(input, "dy"), unit, dpi, target.bounds.bottom - target.bounds.top, lines), wheelY)};
  } catch (const std::invalid_argument &error) { wheelX = wheelY = 0; throw Fault("invalid_request", error.what()); }
}
Observation &Engine::fresh(const Target &target, const Json &input,
                           const Operation &op) {
  auto item = observations.find(op.key() + ":" + target.id);
  if (item == observations.end() ||
      text(input, "observationId") != item->second.id ||
      memcmp(&item->second.target.bounds, &target.bounds, sizeof(RECT)))
    throw Fault("stale_observation", "Read a fresh state before input");
  return item->second;
}
Node &Engine::element(Observation &observation, const Json &input) {
  auto item = observation.nodes.find(text(input, "elementId"));
  if (item == observation.nodes.end())
    throw Fault("stale_element", "Element reference expired");
  auto &node = item->second;
  int type;
  BSTR label = nullptr;
  BOOL enabled, password;
  check(node.element->get_CurrentControlType(&type), "Element is unavailable");
  check(node.element->get_CurrentName(&label), "Element name unavailable");
  std::string name =
      label ? utf8(std::wstring(label, SysStringLen(label))) : "";
  SysFreeString(label);
  check(node.element->get_CurrentIsEnabled(&enabled),
        "Element enabled state unavailable");
  check(node.element->get_CurrentIsPassword(&password),
        "Protected field state unavailable");
  if (std::to_string(type) != node.role || name != node.label || !enabled ||
      (password != FALSE) != node.row.value("secure", false))
    throw Fault("stale_element", "Element identity changed");
  return node;
}
POINT Engine::point(const Target &target, const Observation &observation,
                    const Json &input) {
  double x, y;
  if (input.contains("elementId")) {
    auto &node = element(const_cast<Observation &>(observation), input);
    RECT frame;
    check(node.element->get_CurrentBoundingRectangle(&frame),
          "Element geometry unavailable");
    x = (frame.left + frame.right) / 2.0;
    y = (frame.top + frame.bottom) / 2.0;
  } else {
    if (text(input, "imageId") != observation.imageId ||
        observation.width <= 0 || observation.height <= 0)
      throw Fault("stale_image", "Input requires the exact observed imageId");
    double px = number(input, "x"), py = number(input, "y");
    if (px < 0 || py < 0 || px >= observation.width || py >= observation.height)
      throw Fault("out_of_bounds", "Point is outside observed pixels");
    x = observation.imageBounds.left +
        px * (observation.imageBounds.right - observation.imageBounds.left) /
            observation.width;
    y = observation.imageBounds.top +
        py * (observation.imageBounds.bottom - observation.imageBounds.top) /
            observation.height;
  }
  POINT point{(LONG)std::lround(x), (LONG)std::lround(y)};
  if (!PtInRect(&target.bounds, point))
    throw Fault("out_of_bounds", "Point is outside approved window");
  HWND hit = physicalControlWindowAt(point);
  if (!isolatedInput && hit != target.hwnd)
    throw Fault("obscured_target", "Point is covered by another window");
  return point;
}
void Engine::verifyForeground(const Target &target, const Operation &op) {
  op.guard();
  if (userInterrupted || owner != op.key() ||
      (!isolatedInput && GetForegroundWindow() != target.hwnd) || !IsWindow(target.hwnd))
    throw Fault("foreground_required", "User changed focus or input ownership");
  auto current = this->target(target.json());
  if (current.id != target.id ||
      memcmp(&current.bounds, &target.bounds, sizeof(RECT)))
    throw Fault("stale_target", "Window identity or geometry changed");
  HWND popup = GetLastActivePopup(target.hwnd);
  if (popup != target.hwnd && IsWindowVisible(popup))
    throw Fault("modal_active", "Select the active owned dialog before input");
}
void Engine::send(std::vector<INPUT> events, const Target &target,
                  const Operation &op) {
  verifyForeground(target, op);
  if (events.empty() || events.size() > 256)
    throw Fault("invalid_request", "Input batch exceeds limit");
  UINT accepted = sendTrackedInput(events);
  acceptedSegments += accepted;
  if (accepted != events.size()) {
    throw Fault("partial_input",
                "Windows did not accept the complete input batch",
                {{"outcome", accepted ? "partial-or-unknown" : "unknown"},
                 {"acceptedSegments", accepted},
                 {"requestedSegments", events.size()}});
  }
}
Json Engine::action(const std::string &method, const Target &target,
                    const Json &input, const Operation &op) {
  if (integrityLevel(target.pid) > integrityLevel(GetCurrentProcessId()))
    throw Fault("integrity_restricted",
                "Elevated targets require manual interaction");
  auto mode = input.value("inputMode", "isolated");
  if (mode != "isolated" && mode != "foreground") throw Fault("invalid_request", "Invalid inputMode");
  isolatedInput = method != "activate" && mode == "isolated";
  if (!isolatedInput && GetForegroundWindow() != target.hwnd) {
    if (userInterrupted)
      throw Fault("foreground_required",
                  "Continue control explicitly after focus changed");
    if (!SetForegroundWindow(target.hwnd))
      throw Fault("foreground_required",
                  "Windows did not permit foreground activation");
  }
  inputWindow = target.hwnd;
  verifyForeground(target, op);
  if (method == "activate")
    return {{"status", "accepted"}, {"target", target.json()}};
  auto &observation = fresh(target, input, op);
  if (method == "click" && input.contains("elementId") && number(input, "button") == 0 && number(input, "clickCount", 1) == 1) {
    auto &node = element(observation, input);
    const auto actions = node.row.value("actions", Json::array());
    for (const auto *primary : {"invoke", "toggle"}) {
      if (std::find(actions.begin(), actions.end(), Json(primary)) == actions.end()) continue;
      // UIA 的主动作避免空白外接框中心导致无效点击，复用现有唯一语义执行路径。
      auto request = input; request["action"] = primary;
      return action("secondary_action", target, request, op);
    }
  }
  if (isolatedInput && (method == "click" || method == "move" || method == "drag" || method == "scroll" || method == "press_key" || method == "type_text")) {
    isolatedAction(method, target, input, observation, op);
    bool settled = waitForSettled(op);
    return {{"status", "accepted"}, {"inputMode", "isolated"}, {"inputDelivery", "window-procedure-returned"}, {"scrollPrecision", method == "scroll" ? "approximate-wheel" : "not-applicable"}, {"settled", settled}, {"verification", "observe-result"}, {"state", observe(this->target(target.json()), {{"text", true}, {"image", input.value("verifyImage", true)}}, op, false)}};
  }
  auto move = [&](POINT point) {
    INPUT event{};
    event.type = INPUT_MOUSE;
    auto x = GetSystemMetrics(SM_XVIRTUALSCREEN),
         y = GetSystemMetrics(SM_YVIRTUALSCREEN),
         width = GetSystemMetrics(SM_CXVIRTUALSCREEN),
         height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if (width < 2 || height < 2)
      throw Fault("desktop_unavailable", "Invalid desktop geometry");
    event.mi.dx = (LONG)std::lround((point.x - x) * 65535.0 / (width - 1));
    event.mi.dy = (LONG)std::lround((point.y - y) * 65535.0 / (height - 1));
    event.mi.dwFlags =
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    event.mi.dwExtraInfo = InputTag;
    send({event}, target, op);
    controlFeedbackPointer(target, op, point);
  };
  auto mouse = [&](DWORD flags, DWORD data = 0) {
    INPUT event{};
    event.type = INPUT_MOUSE;
    event.mi.dwFlags = flags;
    event.mi.mouseData = data;
    event.mi.dwExtraInfo = InputTag;
    return event;
  };
  if (method == "click" || method == "move" || method == "scroll") {
    move(point(target, observation, input));
    if (method == "click") {
      auto button = number(input, "button"),
           count = number(input, "clickCount", 1);
      if (button < 0 || button > 2 || count < 1 || count > 3 ||
          std::floor(button) != button || std::floor(count) != count)
        throw Fault("invalid_request", "Invalid click parameters");
      DWORD down = button == 1   ? MOUSEEVENTF_RIGHTDOWN
                   : button == 2 ? MOUSEEVENTF_MIDDLEDOWN
                                 : MOUSEEVENTF_LEFTDOWN,
            up = button == 1   ? MOUSEEVENTF_RIGHTUP
                 : button == 2 ? MOUSEEVENTF_MIDDLEUP
                               : MOUSEEVENTF_LEFTUP;
      for (int i = 0; i < count; i++)
        { controlFeedbackPointer(target, op, point(target, observation, input), true);
          send({mouse(down), mouse(up)}, target, op);
          controlFeedbackPointer(target, op, point(target, observation, input), false); }
    }
    if (method == "scroll") {
      auto delta = wheel(target, input);
      if (delta.y)
        send({mouse(MOUSEEVENTF_WHEEL, (DWORD)-delta.y)}, target,
             op);
      if (delta.x)
        send({mouse(MOUSEEVENTF_HWHEEL, (DWORD)delta.x)}, target,
             op);
    }
  } else if (method == "drag") {
    const auto &path = input.at("path");
    if (!path.is_array() || path.size() < 2 || path.size() > 1000)
      throw Fault("invalid_request", "Invalid drag path");
    auto first = input;
    first.update(path[0]);
    move(point(target, observation, first));
    const double dragButton = number(input, "button");
    if (dragButton != std::floor(dragButton) || dragButton < 0 || dragButton > 2) throw Fault("invalid_request", "Invalid drag button");
    const DWORD dragDown = dragButton == 1 ? MOUSEEVENTF_RIGHTDOWN : dragButton == 2 ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_LEFTDOWN;
    const DWORD dragUp = dragButton == 1 ? MOUSEEVENTF_RIGHTUP : dragButton == 2 ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_LEFTUP;
    send({mouse(dragDown)}, target, op);
    controlFeedbackPointer(target, op, point(target, observation, first), true);
    try {
      for (size_t i = 1; i < path.size(); i++) {
        auto next = input;
        next.update(path[i]);
        move(point(target, observation, next));
        controlFeedbackPointer(target, op, point(target, observation, next), true);
        op.guard();
      }
      send({mouse(dragUp)}, target, op);
      auto last = input; last.update(path.back()); controlFeedbackPointer(target, op, point(target, observation, last), false);
    } catch (...) {
      cleanupInput();
      throw;
    }
  } else if (method == "press_key" || method == "type_text") {
    ComPtr<IUIAutomationElement> focused;
    check(uia()->GetFocusedElement(&focused),
          "Focused element unavailable");
    int pid;
    BOOL protectedValue;
    check(focused->get_CurrentProcessId(&pid), "Focus identity unavailable");
    check(focused->get_CurrentIsPassword(&protectedValue),
          "Protected field state unavailable");
    if ((DWORD)pid != target.pid || protectedValue)
      throw Fault("manual_input_required", "Focus is unverified or protected");
    if (method == "type_text" && input.value("mode", "unicode") == "clipboard")
      pasteText(text(input, "text", 400000), target, op,
                [&](auto events) { send(events, target, op); });
    else if (method == "type_text") {
      auto value = wide(text(input, "text", 400000));
      if (value.size() > 100000)
        throw Fault("invalid_request", "Text exceeds its limit");
      for (size_t i = 0; i < value.size(); i++) {
        std::vector<INPUT> events{keyboard(value[i], false, true),
                                  keyboard(value[i], true, true)};
        if (value[i] >= 0xD800 && value[i] <= 0xDBFF) {
          if (i + 1 >= value.size() || value[i + 1] < 0xDC00 ||
              value[i + 1] > 0xDFFF)
            throw Fault("invalid_text", "Invalid Unicode surrogate");
          i++;
          events.push_back(keyboard(value[i], false, true));
          events.push_back(keyboard(value[i], true, true));
        }
        send(events, target, op);
      }
    } else if (input.contains("scanCode")) {
      auto value = number(input, "scanCode");
      zcode::input::ScanCode translated;
      try { translated = zcode::input::physicalScan(value, input.value("extended", false)); }
      catch (const std::invalid_argument &error) { throw Fault("invalid_request", error.what()); }
      INPUT down{};
      down.type = INPUT_KEYBOARD;
      down.ki.wScan = translated.scan;
      down.ki.dwFlags =
          KEYEVENTF_SCANCODE | (translated.extended ? KEYEVENTF_EXTENDEDKEY : 0);
      down.ki.dwExtraInfo = InputTag;
      INPUT up = down;
      up.ki.dwFlags |= KEYEVENTF_KEYUP;
      send({down, up}, target, op);
    } else {
      std::string chord = text(input, "key");
      std::vector<WORD> codes;
      size_t start = 0;
      while (true) {
        auto end = chord.find('+', start);
        auto part = chord.substr(start, end - start);
        std::transform(part.begin(), part.end(), part.begin(),
                       [](unsigned char c) { return (char)std::tolower(c); });
        part = zcode::input::keyAlias(part);
        std::map<std::string, WORD> named{
            {"ctrl", VK_CONTROL},  {"control", VK_CONTROL},
            {"shift", VK_SHIFT},   {"alt", VK_MENU},
            {"meta", VK_LWIN},     {"super", VK_LWIN},
            {"enter", VK_RETURN},  {"tab", VK_TAB},
            {"escape", VK_ESCAPE}, {"esc", VK_ESCAPE},
            {"space", VK_SPACE},   {"backspace", VK_BACK},
            {"delete", VK_DELETE}, {"left", VK_LEFT},
            {"right", VK_RIGHT},   {"up", VK_UP},
            {"down", VK_DOWN},     {"home", VK_HOME},
            {"end", VK_END},       {"pageup", VK_PRIOR},
            {"pagedown", VK_NEXT}};
        WORD code = named.count(part) ? named[part] : 0;
        if (!code && part.size() == 1) {
          SHORT mapping =
              VkKeyScanExW(wide(part)[0],
                           GetKeyboardLayout(
                               GetWindowThreadProcessId(target.hwnd, nullptr)));
          if (mapping != -1) {
            code = LOBYTE(mapping);
            if (HIBYTE(mapping) & 1)
              codes.push_back(VK_SHIFT);
            if (HIBYTE(mapping) & 2)
              codes.push_back(VK_CONTROL);
            if (HIBYTE(mapping) & 4)
              codes.push_back(VK_MENU);
          }
        }
        if (!code && part.size() >= 2 && part[0] == 'f') {
          int f = std::stoi(part.substr(1));
          if (f >= 1 && f <= 24)
            code = (WORD)(VK_F1 + f - 1);
        }
        if (!code)
          throw Fault("unsupported_key",
                      "Key is unavailable in target keyboard layout");
        codes.push_back(code);
        if (end == std::string::npos)
          break;
        start = end + 1;
      }
      std::vector<INPUT> events;
      for (auto code : codes)
        events.push_back(keyboard(code, false));
      for (auto it = codes.rbegin(); it != codes.rend(); ++it)
        events.push_back(keyboard(*it, true));
      send(events, target, op);
    }
  } else {
    auto &node = element(observation, input);
    if (node.row.value("secure", false))
      throw Fault("manual_input_required",
                  "Protected fields require manual input");
    if (method == "set_value") {
      ComPtr<IUIAutomationValuePattern> pattern;
      check(node.element->GetCurrentPatternAs(UIA_ValuePatternId,
                                              IID_PPV_ARGS(&pattern)),
            "Target is not settable");
      BSTR value;
      check(pattern->get_CurrentValue(&value), "Editable value unavailable");
      std::string current =
          value ? utf8(std::wstring(value, SysStringLen(value))) : "";
      SysFreeString(value);
      if (current != node.value)
        throw Fault("stale_element", "Editable value changed");
      verifyForeground(target, op);
      // UIA 参数是有长度前缀的 BSTR，普通 wchar_t 缓冲区会在 COM 编组时越界。
      auto replacement = automationString(text(input, input.contains("text") ? "text" : "value", 400000));
      check(pattern->SetValue(replacement.get()),
            "Value change failed");
    } else if (method == "secondary_action") {
      auto action = text(input, "action");
      verifyForeground(target, op);
      if (action == "invoke") {
        ComPtr<IUIAutomationInvokePattern> pattern;
        check(node.element->GetCurrentPatternAs(UIA_InvokePatternId,
                                                IID_PPV_ARGS(&pattern)),
              "Invoke unsupported");
        check(pattern->Invoke(), "Invoke failed");
      } else if (action == "toggle") {
        ComPtr<IUIAutomationTogglePattern> pattern;
        check(node.element->GetCurrentPatternAs(UIA_TogglePatternId,
                                                IID_PPV_ARGS(&pattern)),
              "Toggle unsupported");
        check(pattern->Toggle(), "Toggle failed");
      } else if (action == "expand" || action == "collapse") {
        ComPtr<IUIAutomationExpandCollapsePattern> pattern;
        check(node.element->GetCurrentPatternAs(UIA_ExpandCollapsePatternId,
                                                IID_PPV_ARGS(&pattern)),
              "Expansion unsupported");
        check(action == "expand" ? pattern->Expand() : pattern->Collapse(),
              "Expansion failed");
      } else if (action == "select") {
        ComPtr<IUIAutomationSelectionItemPattern> pattern;
        check(node.element->GetCurrentPatternAs(UIA_SelectionItemPatternId,
                                                IID_PPV_ARGS(&pattern)),
              "Selection unsupported");
        check(pattern->Select(), "Selection failed");
      } else
        throw Fault("action_unavailable", "Unsupported control pattern action");
    } else if (method == "select_text") {
      ComPtr<IUIAutomationTextPattern> pattern;
      check(node.element->GetCurrentPatternAs(UIA_TextPatternId,
                                              IID_PPV_ARGS(&pattern)),
            "Text selection unsupported");
      ComPtr<IUIAutomationTextRange> document;
      check(pattern->get_DocumentRange(&document), "Text range unavailable");
      auto query = wide(text(input, "text", 400000));
      auto searchText = automationString(text(input, "text", 400000));
      if (query.empty())
        throw Fault("invalid_request", "Selection text must not be empty");
      std::vector<ComPtr<IUIAutomationTextRange>> matches;
      ComPtr<IUIAutomationTextRange> remaining;
      document->Clone(&remaining);
      for (int i = 0; i < 1000; i++) {
        op.guard();
        ComPtr<IUIAutomationTextRange> match;
        check(remaining->FindText(searchText.get(), FALSE, FALSE, &match),
              "Text search unavailable");
        if (!match)
          break;
        bool accepted = true;
        for (bool before : {true, false}) {
          auto context = wide(input.value(before ? "prefix" : "suffix", ""));
          if (context.empty())
            continue;
          ComPtr<IUIAutomationTextRange> surrounding;
          check(match->Clone(&surrounding), "Text context unavailable");
          auto endpoint = before ? TextPatternRangeEndpoint_Start
                                 : TextPatternRangeEndpoint_End;
          check(surrounding->MoveEndpointByRange(
                    before ? TextPatternRangeEndpoint_End
                           : TextPatternRangeEndpoint_Start,
                    match.Get(), endpoint),
                "Text context unavailable");
          int moved = 0;
          check(surrounding->MoveEndpointByUnit(
                    endpoint, TextUnit_Character,
                    (before ? -1 : 1) * static_cast<int>(context.size()),
                    &moved),
                "Text context unavailable");
          BSTR text = nullptr;
          check(surrounding->GetText(8192, &text), "Text context unavailable");
          std::wstring value =
              text ? std::wstring(text, SysStringLen(text)) : L"";
          if (text)
            SysFreeString(text);
          accepted = accepted && (before ? value.ends_with(context)
                                         : value.starts_with(context));
        }
        if (accepted)
          matches.push_back(match);
        check(remaining->MoveEndpointByRange(TextPatternRangeEndpoint_Start,
                                             match.Get(),
                                             TextPatternRangeEndpoint_End),
              "Text range advance failed");
      }
      auto index = number(input, "occurrence", matches.size() == 1 ? 0 : -1);
      if (index < 0 || index != std::floor(index) || index >= matches.size())
        throw Fault("ambiguous_text", "Specify the exact text occurrence");
      auto range = matches[(size_t)index];
      auto mode = input.value("mode", "select");
      if (mode == "before")
        range->MoveEndpointByRange(TextPatternRangeEndpoint_End, range.Get(),
                                   TextPatternRangeEndpoint_Start);
      else if (mode == "after")
        range->MoveEndpointByRange(TextPatternRangeEndpoint_Start, range.Get(),
                                   TextPatternRangeEndpoint_End);
      else if (mode != "select")
        throw Fault("invalid_request", "Invalid selection mode");
      verifyForeground(target, op);
      check(range->Select(), "Text selection failed");
    } else
      throw Fault("unknown_method", "Unknown input method");
  }
  op.guard();
  bool settled = waitForSettled(op);
  return {{"status", "accepted"},
          {"inputMode", isolatedInput ? "isolated" : "foreground"},
          {"scrollPrecision", method == "scroll" ? "approximate-wheel" : "not-applicable"},
          {"settled", settled},
          {"verification", "observe-result"},
          {"state", observe(this->target(target.json()),
                            {{"text", true},
                             {"image", input.value("verifyImage", true)}},
                            op, false)}};
}
