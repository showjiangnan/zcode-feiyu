// Modified by ZCode Feiyu contributors (2026).
import AppKit
import ApplicationServices
import Carbon
import Foundation

extension NativeEngine {
  func freshObservation(_ target: WindowTarget, _ input: [String: Any], _ operation: Operation)
    throws -> Observation
  {
    guard let observation = observations["\(operation.key):\(target.identity)"],
      input["observationId"] as? String == observation.id,
      observation.target.frame.equalTo(target.frame), observation.changeSequence == changeSequence
    else {
      throw ControlError(
        "stale_observation", "Read a fresh target state before performing an action")
    }
    return observation
  }
  func element(_ input: [String: Any], _ observation: Observation) throws -> ObservedNode {
    let id = try requiredString(input["elementId"], "elementId")
    guard let node = observation.nodes[id], axString(node.element, kAXRoleAttribute) == node.role,
      (axString(node.element, kAXSubroleAttribute) == kAXSecureTextFieldSubrole)
        == (node.json["secure"] as? Bool == true),
      axString(node.element, kAXTitleAttribute).isEmpty
        || axString(node.element, kAXTitleAttribute) == node.label,
      (axValue(node.element, kAXEnabledAttribute) as? Bool) != false
    else {
      throw ControlError("stale_element", "Element identity or capability changed; observe again")
    }
    return node
  }
  func activate(_ target: WindowTarget, _ operation: Operation) async throws {
    try operation.check()
    guard !focusBlocked.contains(operation.key) else {
      throw ControlError("foreground_required", "User changed focus; continue explicitly")
    }
    // 同应用另一窗口成为前台后，仅 AXRaise 的焦点回执不足以确认系统应用排序。
    // 每次走正常激活，随后仍检查确切窗口和实际命中，不越过人工暂停。
    target.app.activate(options: [.activateAllWindows])
    if let window = target.ax { AXUIElementPerformAction(window, kAXRaiseAction as CFString) }
    repeat {
      try operation.check()
      if focusBlocked.contains(operation.key) {
        throw ControlError("foreground_required", "User changed focus during activation")
      }
      if NSWorkspace.shared.frontmostApplication?.processIdentifier == target.app.processIdentifier
      {
        if let ax = target.ax {
          let app = AXUIElementCreateApplication(target.app.processIdentifier)
          guard let focused = axValue(app, kAXFocusedWindowAttribute), CFEqual(ax, focused) else {
            throw ControlError("foreground_required", "A different or modal window has focus")
          }
        }
        return
      }
      try await Task.sleep(nanoseconds: 10_000_000)
    } while true
  }
  func point(_ input: [String: Any], _ target: WindowTarget, _ observation: Observation) throws
    -> CGPoint
  {
    if input["elementId"] != nil {
      let node = try element(input, observation)
      guard let frame = axFrame(node.element) else {
        throw ControlError("element_unavailable", "Element geometry is unavailable")
      }
      let point = CGPoint(x: frame.midX, y: frame.midY)
      guard target.frame.contains(point) else {
        throw ControlError("out_of_bounds", "Element is outside the approved window")
      }
      return point
    }
    guard input["imageId"] as? String == observation.imageId, observation.imageWidth > 0,
      observation.imageHeight > 0
    else {
      throw ControlError("stale_image", "Coordinate input requires the exact observed imageId")
    }
    let x = try finite(input["x"], "x")
    let y = try finite(input["y"], "y")
    guard x >= 0, y >= 0, x < Double(observation.imageWidth), y < Double(observation.imageHeight)
    else { throw ControlError("out_of_bounds", "Point is outside the observed image") }
    return CGPoint(
      x: target.frame.minX + observation.imageBounds.minX + x * observation.imageBounds.width
        / Double(observation.imageWidth),
      y: target.frame.minY + observation.imageBounds.minY + y * observation.imageBounds.height
        / Double(observation.imageHeight))
  }
  func verifyHit(_ point: CGPoint, _ target: WindowTarget) throws {
    let hit = windowHit(point, target)
    guard let matches = hit.matches else {
      throw ControlError(
        "hit_test_unavailable", "Cannot verify the actual input target", hit.details)
    }
    guard matches else {
      throw ControlError("obscured_target", "Point is covered by a different window", hit.details)
    }
  }

  func post(_ event: CGEvent?, _ operation: Operation) throws {
    try operation.check()
    guard var event else {
      throw ControlError("event_creation_failed", "Native input event could not be created")
    }
    guard let target = currentTarget else { throw ControlError("target_unavailable", "No input target") }
    try verifyInputTarget(target, operation)
    if currentInputRoute == .isolated { event = try isolatedEvent(event, target) }
    // 每个键段复核确切焦点窗口和保护字段，不能仅按应用 PID 向新模态窗口继续发键。
    if event.type == .keyDown || event.type == .keyUp { try verifyKeyboardTarget(target) }
    stampTarget(event, target)
    try recordInput(event, target: target)
    postedSegments += 1
    if currentInputRoute == .isolated { event.postToPid(target.app.processIdentifier) }
    else { event.post(tap: .cghidEventTap) }
    if [.leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseUp, .rightMouseUp, .otherMouseUp, .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged].contains(event.type) {
      let down = [.leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged].contains(event.type)
      feedback.pointer(event.location, target: target, operation: operation, pressed: down)
    }
  }
  func perform(
    _ method: String, _ input: [String: Any], _ target: WindowTarget, _ operation: Operation
  ) async throws -> [String: Any] {
    if method == "activate" {
      try await activate(target, operation)
      return ["status": "accepted", "target": target.json]
    }
    let observation = try freshObservation(target, input, operation)
    if currentInputRoute == .foreground { try await activate(target, operation) }
    try verifyInputTarget(target, operation)
    let buttonValue = try finite(input["button"], "button", default: 0)
    guard buttonValue >= 0, buttonValue <= 2, buttonValue.rounded() == buttonValue else {
      throw ControlError("invalid_request", "button must be 0, 1, or 2")
    }
    let button = CGMouseButton(rawValue: UInt32(buttonValue))!
    let down: CGEventType =
      button == .left ? .leftMouseDown : button == .right ? .rightMouseDown : .otherMouseDown
    let up: CGEventType =
      button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp
    switch method {
    case "click":
      let count = try finite(input["clickCount"], "clickCount", default: 1)
      guard count.rounded() == count, count >= 1, count <= 3 else {
        throw ControlError("invalid_request", "clickCount must be 1–3")
      }
      if input["elementId"] != nil, button == .left, count == 1 {
        let node = try element(input, observation)
        if (node.json["actions"] as? [String] ?? []).contains(kAXPressAction) {
          // AX 外接框可能含空白，单击先用控件声明的主动作；失败不重复坐标点击。
          guard node.json["secure"] as? Bool != true else { throw ControlError("manual_input_required", "Enter protected text manually") }
          try verifyInputTarget(target, operation)
          postedSegments += 1
          guard AXUIElementPerformAction(node.element, kAXPressAction as CFString) == .success else {
            throw ControlError("action_failed", "Element primary action failed")
          }
          break
        }
      }
      let point = try point(input, target, observation)
      try verifyPointerTarget(point, target)
      try enforceSyntheticWindowFocus(target, operation)
      try await feedback.movePointer(to: point, target: target, operation: operation)
      for index in 1...Int(count) {
        let event = CGEvent(
          mouseEventSource: nil, mouseType: down, mouseCursorPosition: point, mouseButton: button)
        event?.setIntegerValueField(.mouseEventClickState, value: Int64(index))
        try post(event, operation)
        try post(
          CGEvent(
            mouseEventSource: nil, mouseType: up, mouseCursorPosition: point, mouseButton: button),
          operation)
      }
    case "move":
      let point = try point(input, target, observation)
      try verifyPointerTarget(point, target)
      try enforceSyntheticWindowFocus(target, operation)
      try await feedback.movePointer(to: point, target: target, operation: operation)
      try post(
        CGEvent(
          mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point,
          mouseButton: button), operation)
    case "drag":
      guard let path = input["path"] as? [[String: Any]], path.count >= 2, path.count <= 1000 else {
        throw ControlError("invalid_request", "Drag requires 2–1000 points")
      }
      let points = try path.map { row in
        try point(input.merging(row) { _, new in new }, target, observation)
      }
      guard let first = points.first else {
        throw ControlError("invalid_request", "Drag path is empty")
      }
      try verifyPointerTarget(first, target)
      try enforceSyntheticWindowFocus(target, operation)
      try await feedback.movePointer(to: first, target: target, operation: operation)
      try post(
        CGEvent(
          mouseEventSource: nil, mouseType: down, mouseCursorPosition: first, mouseButton: button),
        operation)
      for point in points.dropFirst() {
        try verifyPointerTarget(point, target)
        let dragged: CGEventType =
          button == .left
          ? .leftMouseDragged : button == .right ? .rightMouseDragged : .otherMouseDragged
        try post(
          CGEvent(
            mouseEventSource: nil, mouseType: dragged, mouseCursorPosition: point,
            mouseButton: button), operation)
        try await Task.sleep(nanoseconds: 10_000_000)
      }
      try post(
        CGEvent(
          mouseEventSource: nil, mouseType: up, mouseCursorPosition: points.last!,
          mouseButton: button), operation)
    case "scroll":
      let point = try point(input, target, observation)
      try verifyPointerTarget(point, target)
      try enforceSyntheticWindowFocus(target, operation)
      try await feedback.movePointer(to: point, target: target, operation: operation)
      var dx = try finite(input["dx"], "dx", default: 0)
      var dy = try finite(input["dy"], "dy", default: 0)
      let unit = input["unit"] as? String ?? "pixels"
      guard ["pixels", "points", "lines", "pages"].contains(unit) else {
        throw ControlError("invalid_request", "Unknown scroll unit")
      }
      if unit == "pages" {
        dx *= target.frame.width
        dy *= target.frame.height
      }
      guard abs(dx) <= 100_000, abs(dy) <= 100_000 else {
        throw ControlError("invalid_request", "Scroll magnitude is too large")
      }
      try post(
        CGEvent(
          mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point,
          mouseButton: .left), operation)
      let scroll = CGEvent(scrollWheelEvent2Source: nil, units: unit == "lines" ? .line : .pixel, wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0)
      scroll?.location = point
      try post(scroll, operation)
    case "press_key":
      try enforceSyntheticWindowFocus(target, operation)
      try verifyKeyboardTarget(target)
      try shortcut(input, operation)
    case "type_text":
      try enforceSyntheticWindowFocus(target, operation)
      try verifyKeyboardTarget(target)
      let text = try inputText(input["text"], "text")
      if input["mode"] as? String == "clipboard" {
        try await pasteText(text, operation)
      } else {
        try await unicodeText(text, operation)
      }
    case "set_value":
      let node = try element(input, observation)
      let value = try inputText(input["text"] ?? input["value"], "value")
      // 脱敏文案不是安全属性，普通输入框也可能包含这段字面文本。
      guard node.json["secure"] as? Bool != true else {
        throw ControlError("manual_input_required", "Enter protected values manually")
      }
      guard axString(node.element, kAXValueAttribute) == node.value else {
        throw ControlError("stale_element", "Editable value changed since observation")
      }
      guard
        AXUIElementSetAttributeValue(node.element, kAXValueAttribute as CFString, value as CFString)
          == .success
      else { throw ControlError("not_settable", "Target does not support setting its value") }
    case "secondary_action":
      let node = try element(input, observation)
      let action = try requiredString(input["action"], "action")
      let actions = node.json["actions"] as? [String] ?? []
      guard actions.contains(action),
        AXUIElementPerformAction(node.element, action as CFString) == .success
      else {
        throw ControlError("action_unavailable", "Requested accessibility action is not supported")
      }
    case "select_text":
      try enforceSyntheticWindowFocus(target, operation)
      try selectText(input, observation)
    default: throw ControlError("unknown_method", "Unknown input action")
    }
    try operation.check()
    let settled = try await waitForSettled(operation, since: observation.changeSequence)
    try operation.check()
    let fresh = try self.target(target.json)
    let state = try await observe(
      fresh, ["image": input["verifyImage"] as? Bool ?? true, "text": true, "disableDiff": true],
      operation, preview: false)
    reconcileInputReleases()
    let changed =
      observations["\(operation.key):\(target.identity)"]?.fingerprint != observation.fingerprint
    return [
      "status": changed && settled ? "verified" : "accepted", "settled": settled,
      "verification": changed ? "observed-state-change" : "no-semantic-change-observed",
      "inputMode": currentInputRoute.rawValue,
      "state": state,
    ]
  }
  func verifyKeyboardTarget(_ target: WindowTarget) throws {
    guard let ax = target.ax else {
      throw ControlError(
        "foreground_required", "Keyboard input needs a verified accessibility window")
    }
    let app = AXUIElementCreateApplication(target.app.processIdentifier)
    guard let focused = axValue(app, kAXFocusedWindowAttribute), CFEqual(ax, focused) else {
      throw ControlError("foreground_required", "A different window has keyboard focus")
    }
    if let element = axValue(app, kAXFocusedUIElementAttribute),
      CFGetTypeID(element) == AXUIElementGetTypeID(),
      axString(unsafeBitCast(element, to: AXUIElement.self), kAXSubroleAttribute)
        == kAXSecureTextFieldSubrole
    {
      throw ControlError("manual_input_required", "Enter protected text manually")
    }
  }
  func shortcut(_ input: [String: Any], _ operation: Operation) throws {
    if input["physicalKeyCode"] != nil {
      let value = try finite(input["physicalKeyCode"], "physicalKeyCode")
      guard value >= 0, value <= 127, value.rounded() == value else {
        throw ControlError("invalid_request", "Invalid physical key code")
      }
      let code = CGKeyCode(value)
      try post(CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true), operation)
      try post(CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false), operation)
      return
    }
    let chord = try requiredString(input["key"], "key")
    let parts = chord.split(separator: "+").map(String.init)
    guard let key = parts.last else { throw ControlError("invalid_request", "Key is empty") }
    var flags: CGEventFlags = []
    for modifier in parts.dropLast() {
      switch modifier.lowercased() {
      case "cmd", "command", "meta", "super": flags.insert(.maskCommand)
      case "ctrl", "control": flags.insert(.maskControl)
      case "alt", "option": flags.insert(.maskAlternate)
      case "shift": flags.insert(.maskShift)
      default: throw ControlError("invalid_request", "Unknown modifier")
      }
    }
    let names: [String: CGKeyCode] = [
      "enter": 36, "return": 36, "tab": 48, "space": 49, "escape": 53, "esc": 53, "backspace": 51,
      "delete": 117, "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119,
      "pageup": 116, "pagedown": 121, "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
      "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    ]
    var code = names[key.lowercased()]
    if code == nil, let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
      let property = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
    {
      let data = unsafeBitCast(property, to: CFData.self)
      let layout = unsafeBitCast(CFDataGetBytePtr(data), to: UnsafePointer<UCKeyboardLayout>.self)
      for candidate in UInt16(0)...UInt16(127) {
        var dead: UInt32 = 0
        var length = 0
        var chars = [UniChar](repeating: 0, count: 8)
        let result = UCKeyTranslate(
          layout, candidate, UInt16(kUCKeyActionDisplay), 0, UInt32(LMGetKbdType()),
          OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, chars.count, &length, &chars)
        if result == noErr,
          String(utf16CodeUnits: chars, count: length).lowercased() == key.lowercased()
        {
          code = candidate
          break
        }
      }
    }
    guard let code else {
      throw ControlError("unsupported_key", "Key is unavailable in the current keyboard layout")
    }
    let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
    down?.flags = flags
    try post(down, operation)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    up?.flags = []
    try post(up, operation)
  }
  func selectText(_ input: [String: Any], _ observation: Observation) throws {
    let node = try element(input, observation)
    let query = try requiredString(input["text"], "text")
    let value = axString(node.element, kAXValueAttribute) as NSString
    guard node.json["secure"] as? Bool != true, value as String == node.value else {
      throw ControlError("stale_element", "Text changed since observation")
    }
    var ranges: [NSRange] = []
    var location = 0
    while location < value.length {
      let range = value.range(
        of: query, options: [], range: NSRange(location: location, length: value.length - location))
      if range.location == NSNotFound { break }
      let prefix = input["prefix"] as? String ?? ""
      let suffix = input["suffix"] as? String ?? ""
      if value.substring(to: range.location).hasSuffix(prefix)
        && value.substring(from: NSMaxRange(range)).hasPrefix(suffix)
      {
        ranges.append(range)
      }
      location = range.location + max(1, range.length)
    }
    let occurrence = try finite(
      input["occurrence"], "occurrence", default: ranges.count == 1 ? 0 : -1)
    guard occurrence >= 0, occurrence.rounded() == occurrence, occurrence < Double(ranges.count)
    else {
      throw ControlError(
        "ambiguous_text", "Text selection is absent or ambiguous; specify occurrence")
    }
    let range = ranges[Int(occurrence)]
    let mode = input["mode"] as? String ?? "select"
    guard ["select", "before", "after"].contains(mode) else {
      throw ControlError("invalid_request", "Invalid selection mode")
    }
    var cfRange = CFRange(
      location: mode == "after" ? NSMaxRange(range) : range.location,
      length: mode == "select" ? range.length : 0)
    guard let selected = AXValueCreate(.cfRange, &cfRange),
      AXUIElementSetAttributeValue(
        node.element, kAXSelectedTextRangeAttribute as CFString, selected) == .success
    else { throw ControlError("not_selectable", "Target does not support selected text ranges") }
  }
}
