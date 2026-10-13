// Modified by ZCode Feiyu.
import AppKit
import ApplicationServices
import Foundation

extension NativeEngine {
  func installStopMonitor() {
    if eventTap != nil { return }
    if observers.isEmpty {
      let lock: @Sendable (Notification) -> Void = { [weak self] _ in
        Task { @MainActor in
          guard let self else { return }
          self.sessionActive = false
          self.stopCurrentControl(reason: "locked")
        }
      }
      let unlock: @Sendable (Notification) -> Void = { [weak self] _ in
        Task { @MainActor in self?.sessionActive = true }
      }
      observers.append(
        NSWorkspace.shared.notificationCenter.addObserver(
          forName: NSWorkspace.sessionDidResignActiveNotification, object: nil, queue: .main,
          using: lock))
      observers.append(
        NSWorkspace.shared.notificationCenter.addObserver(
          forName: NSWorkspace.sessionDidBecomeActiveNotification, object: nil, queue: .main,
          using: unlock))
      observers.append(
        DistributedNotificationCenter.default().addObserver(
          forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: .main,
          using: lock))
      observers.append(
        DistributedNotificationCenter.default().addObserver(
          forName: Notification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main,
          using: unlock))
    }
    let mask =
      (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.leftMouseDown.rawValue)
      | (1 << CGEventType.rightMouseDown.rawValue)
      | (1 << CGEventType.mouseMoved.rawValue) | (1 << CGEventType.leftMouseDragged.rawValue)
      | (1 << CGEventType.otherMouseDown.rawValue)
    let monitor = ManagedEventTap { [weak self] type, event in
      Task(priority: .high) { @MainActor in self?.receiveMonitoredInput(type, event) }
    }
    monitor.start(mask: CGEventMask(mask))
    managedEventTap = monitor
    eventTap = monitor.tap
  }
  func receiveMonitoredInput(_ type: CGEventType, _ value: CGEvent?) {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      pauseCurrentControl(reason: "stop-monitor-interrupted", origin: "native")
      return
    }
    guard let event = value else { pauseCurrentControl(reason: "stop-monitor-interrupted", origin: "native"); return }
    if event.getIntegerValueField(.eventSourceUserData) == nativeEventTag {
      if type != .keyDown { taggedGlobalPointerEvents += 1 }
      return
    }
    if type == .mouseMoved || type == .leftMouseDragged || device.owner == nil { return }
    let targeted = currentTarget.map { humanEventTargetsWindow(event, type, $0) } ?? false
    let origin = event.getIntegerValueField(.eventSourceUnixProcessID) > 0 ? "external-input" : "system-or-unclassified"
    let decision = inputIntervention(ownEvent: false, hasOwner: true, targetsWindow: targeted,
      escape: type == .keyDown && event.getIntegerValueField(.keyboardEventKeycode) == 53,
      foregroundRoute: currentInputRoute == .foreground)
    switch decision {
    case .stop: stopCurrentControl(reason: "target-escape", origin: origin)
    case .pause: pauseCurrentControl(reason: targeted ? (type == .keyDown ? "target-keyboard" : "target-pointer") : "foreground-changed", origin: origin)
    case .ignore: break
    }
  }
  func humanEventTargetsWindow(_ event: CGEvent, _ type: CGEventType, _ target: WindowTarget)
    -> Bool
  {
    if type == .keyDown {
      guard NSWorkspace.shared.frontmostApplication?.processIdentifier == target.app.processIdentifier else { return false }
      if let expected = target.ax, let focused = axValue(AXUIElementCreateApplication(target.app.processIdentifier), kAXFocusedWindowAttribute) {
        return CFEqual(expected, focused)
      }
      // 无法核实同应用的准确焦点窗口时不把 Esc 归为目标停止，可信 UI stop 仍然可用。
      return false
    }
    // 点击到达事件 tap 时系统尚未切换前台应用，与模型输入共用真实命中路径。
    return windowReceivesPoint(event.location, target) == true
  }

  func pauseCurrentControl(reason: String, origin: String = "native") {
    guard let key = device.owner, !focusBlocked.contains(key) else { return }
    focusBlocked.insert(key)
    feedback.pause(key)
    if let operation = activeOperation { cancellations.cancel(operation.id) }
    if !cleanupInput() { stopCurrentControl(reason: "input-cleanup-unconfirmed"); return }
    if let context = controlContext {
      onControlEvent?(["kind": "control-paused", "context": context, "reason": reason, "origin": origin])
    }
  }

  func stopCurrentControl(reason: String = "unknown-stop", origin: String = "native") {
    if let key = device.owner {
      feedback.remove(key)
      stopped.insert(key)
      observations = observations.filter { !$0.key.hasPrefix(key) }
    }
    if reason == "locked" { feedback.dispose() }
    if let operation = activeOperation { cancellations.cancel(operation.id) }
    if cleanupInput() { device.release() }
    pruneChangeObservers()
    if let context = controlContext {
      onControlEvent?(["kind": "control-stopped", "context": context, "reason": reason, "origin": origin])
    }
  }
  @discardableResult func cleanupInput() -> Bool {
    defer { restoreSyntheticFocus() }
    return releaseTrackedInput()
  }
}
