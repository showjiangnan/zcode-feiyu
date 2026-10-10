// Modified by ZCode Feiyu contributors (2026).
#include "Control.hpp"
#include <sstream>
static std::string bstr(BSTR value) {
  if (!value)
    return "";
  auto result = utf8(std::wstring(value, SysStringLen(value)));
  SysFreeString(value);
  return result;
}
Json Engine::observe(const Target &target, const Json &input,
                     const Operation &operation, bool preview) {
  operation.guard();
  auto id = uniqueId();
  Json body = target.json(), channels = Json::object(), rows = Json::array(),
       continuation = Json::array();
  std::map<std::string, Node> nodes;
  auto key = operation.key() + ":" + target.id;
  auto previous = observations.find(key);
  bool wantText = !preview && input.value("text", true);
  bool wantImage = preview || input.value("image", true);
  if (wantText) {
    try {
      ComPtr<IUIAutomationElement> root;
      check(uia()->ElementFromHandle(target.hwnd, &root),
            "Exact UIA window unavailable");
      UIA_HWND hwnd;
      check(root->get_CurrentNativeWindowHandle(&hwnd),
            "UIA identity unavailable");
      if ((HWND)hwnd != target.hwnd)
        throw Fault("uia_target_mismatch", "UIA returned a different window");
      if (input.contains("elementId")) {
        if (previous == observations.end())
          throw Fault("stale_element", "Subtree reference expired");
        root = element(previous->second, input).element;
      }
      ComPtr<IUIAutomationTreeWalker> walker;
      check(uia()->get_ControlViewWalker(&walker),
            "UIA walker unavailable");
      if (input.contains("childOffset")) {
        auto offset = number(input, "childOffset");
        if (offset < 0 || std::floor(offset) != offset || offset > 100000)
          throw Fault("invalid_request", "Invalid childOffset");
        ComPtr<IUIAutomationElement> child;
        check(walker->GetFirstChildElement(root.Get(), &child),
              "UIA child unavailable");
        for (int i = 0; child && i < offset; i++) {
          ComPtr<IUIAutomationElement> next;
          walker->GetNextSiblingElement(child.Get(), &next);
          child = next;
          operation.guard();
        }
        if (!child)
          throw Fault("stale_element", "Continuation child no longer exists");
        root = child;
      }
      auto maximumValue = number(input, "maxNodes", 1000);
      if (maximumValue < 1 || maximumValue > 5000 ||
          std::floor(maximumValue) != maximumValue)
        throw Fault("invalid_request", "maxNodes must be 1–5000");
      size_t maximum = (size_t)maximumValue;
      struct Entry {
        ComPtr<IUIAutomationElement> element;
        std::string path;
        int depth;
      };
      std::vector<Entry> stack{{root, "0", 0}};
      while (!stack.empty() && rows.size() < maximum) {
        operation.guard();
        auto item = stack.back();
        stack.pop_back();
        int type = 0, pid = 0;
        BOOL password = FALSE, enabled = FALSE, focused = FALSE;
        BSTR name = nullptr;
        RECT rect{};
        check(item.element->get_CurrentProcessId(&pid),
              "UIA element process unavailable");
        if ((DWORD)pid != target.pid)
          continue;
        check(item.element->get_CurrentControlType(&type),
              "UIA element role unavailable");
        check(item.element->get_CurrentIsPassword(&password),
              "UIA protected state unavailable");
        item.element->get_CurrentName(&name);
        std::string label = bstr(name), value;
        item.element->get_CurrentIsEnabled(&enabled);
        item.element->get_CurrentHasKeyboardFocus(&focused);
        item.element->get_CurrentBoundingRectangle(&rect);
        Json actions = Json::array();
        ComPtr<IUIAutomationValuePattern> editable;
        if (SUCCEEDED(item.element->GetCurrentPatternAs(
                UIA_ValuePatternId, IID_PPV_ARGS(&editable))) &&
            editable) {
          // 不读取保护字段的实际值；属性失败时也不能把保护状态默认为 false。
          if (password)
            value = "[protected]";
          else {
            BSTR text = nullptr;
            editable->get_CurrentValue(&text);
            value = bstr(text);
          }
          BOOL readonly = TRUE;
          if (SUCCEEDED(editable->get_CurrentIsReadOnly(&readonly)) &&
              !readonly && !password)
            actions.push_back("set_value");
        }
        ComPtr<IUIAutomationTextPattern> textual;
        if (!password && value.empty() &&
            SUCCEEDED(item.element->GetCurrentPatternAs(
                UIA_TextPatternId, IID_PPV_ARGS(&textual))) &&
            textual) {
          ComPtr<IUIAutomationTextRange> range;
          textual->get_DocumentRange(&range);
          BSTR text = nullptr;
          if (range && SUCCEEDED(range->GetText(4096, &text)))
            value = bstr(text);
          actions.push_back("select_text");
        }
        for (auto pair :
             {std::pair<PATTERNID, const char *>{UIA_InvokePatternId, "invoke"},
              {UIA_TogglePatternId, "toggle"},
              {UIA_ExpandCollapsePatternId, "expand"},
              {UIA_SelectionItemPatternId, "select"}}) {
          ComPtr<IUnknown> pattern;
          if (SUCCEEDED(
                  item.element->GetCurrentPattern(pair.first, &pattern)) &&
              pattern)
            actions.push_back(pair.second);
        }
        auto elementId = id + ":" + item.path;
        auto role = std::to_string(type);
        Json row = {{"elementId", elementId},
                    {"path", item.path},
                    {"role", role},
                    {"label", label.substr(0, 8192)},
                    {"value", value},
                    {"secure", (bool)password},
                    {"enabled", (bool)enabled},
                    {"focused", (bool)focused},
                    {"actions", actions},
                    {"frame",
                     {{"x", rect.left},
                      {"y", rect.top},
                      {"width", rect.right - rect.left},
                      {"height", rect.bottom - rect.top}}}};
        nodes.emplace(elementId,
                      Node{item.element, elementId, role, label, value, row});
        rows.push_back(row);
        ComPtr<IUIAutomationElement> child;
        walker->GetFirstChildElement(item.element.Get(), &child);
        if (!child)
          continue;
        size_t offset = 0;
        std::vector<Entry> children;
        while (child &&
               rows.size() + stack.size() + children.size() < maximum &&
               item.depth < 128) {
          operation.guard();
          children.push_back({child, item.path + "." + std::to_string(offset++),
                              item.depth + 1});
          ComPtr<IUIAutomationElement> next;
          walker->GetNextSiblingElement(child.Get(), &next);
          child = next;
        }
        if (child)
          continuation.push_back(
              {{"elementId", elementId}, {"offset", offset}});
        for (auto i = children.rbegin(); i != children.rend(); ++i)
          stack.push_back(*i);
      }
      channels["text"] = {{"status", "available"}};
    } catch (const Fault &failure) {
      if (failure.code == "cancelled" || failure.code == "deadline" ||
          failure.code == "stale_element")
        throw;
      channels["text"] = {{"status", "unsupported"}, {"reason", failure.code}};
    }
  }
  std::string imageId;
  int width = 0, height = 0;
  RECT imageBounds = target.bounds;
  if (wantImage) {
    if (preview && containsControlPreview(target.pid))
      channels["image"] = {{"status", "preview-paused"},
                           {"reason", "Target contains the preview itself"}};
    else {
      try {
        auto raster = captureWindow(target, operation, preview, input);
        imageId = uniqueId();
        width = raster.width;
        height = raster.height;
        imageBounds = raster.bounds;
        body["image"] = {
            {"data", raster.data},     {"mimeType", raster.mimeType},
            {"imageId", imageId},      {"width", width},
            {"height", height},        {"coordinateSpace", "image-pixels"},
            {"colorSpace", "sRGB-SDR"}};
        channels["image"] = {{"status", "available"}};
      } catch (const Fault &failure) {
        if (failure.code == "cancelled" || failure.code == "deadline" ||
            failure.code == "locked")
          throw;
        channels["image"] = {{"status", "unavailable"},
                             {"reason", failure.code}};
      }
    }
  }
  operation.guard();
  auto current = this->target(target.json());
  if (current.id != target.id ||
      memcmp(&current.bounds, &target.bounds, sizeof(RECT)))
    throw Fault("inconsistent_observation",
                "Window geometry changed while observing");
  body["imageBounds"] = {{"x", imageBounds.left - target.bounds.left},
                         {"y", imageBounds.top - target.bounds.top},
                         {"width", imageBounds.right - imageBounds.left},
                         {"height", imageBounds.bottom - imageBounds.top}};
  body["channels"] = channels;
  body["observationId"] = id;
  body["revision"] = id;
  body["capturedAt"] = std::chrono::duration<double>(
                           std::chrono::system_clock::now().time_since_epoch())
                           .count();
  body["consistency"] = "bounded-sampling";
  if (wantText) {
    body["nodes"] = rows;
    body["truncated"] = !continuation.empty();
    body["continuation"] = continuation;
    body["fullReset"] = true;
    if (input.value("diff", false) && !input.value("disableDiff", false) &&
        previous != observations.end() &&
        input.value("baselineRevision", "") == previous->second.id) {
      Json changed = Json::array(), removed = Json::array();
      std::map<std::string, Json> old;
      for (auto row : previous->second.rows) {
        row.erase("elementId");
        old[row["path"].get<std::string>()] = row;
      }
      for (auto row : rows) {
        auto path = row["path"].get<std::string>();
        auto stable = row;
        stable.erase("elementId");
        if (!old.count(path) || old[path] != stable)
          changed.push_back(row);
        old.erase(path);
      }
      for (auto &pair : old)
        removed.push_back(pair.first);
      body["diff"] = {{"baseRevision", previous->second.id},
                      {"nextRevision", id},
                      {"changed", changed},
                      {"removed", removed}};
      body["fullReset"] = false;
    }
  }
  if (!preview) {
    if (!observations.count(key) && observations.size() >= 128)
      throw Fault("observation_limit", "Close unused control references");
    observations[key] = Observation{id,      target, nodes,  rows,
                                    imageId, width,  height, imageBounds};
  }
  return body;
}
