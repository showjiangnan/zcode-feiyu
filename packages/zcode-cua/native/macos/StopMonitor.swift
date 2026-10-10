// Modified by ZCode Feiyu contributors (2026).
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
    let pointer = Unmanaged.passUnretained(self).toOpaque()
    guard
      let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
        eventsOfInterest: CGEventMask(mask),
        callback: { _, type, event, pointer in
          guard let pointer else { return Unmanaged.passUnretained(event) }
          let engine = Unmanaged<NativeEngine>.fromOpaque(pointer).takeUnretainedValue()
          if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap = engine.eventTap { CGEvent.tapEnable(tap: tap, enable: true) }
            return Unmanaged.passUnretained(event)
          }
          if event.getIntegerValueField(.eventSourceUserData) == nativeEventTag {
            if type != .keyDown { engine.taggedGlobalPointerEvents += 1 }
            return Unmanaged.passUnretained(event)
          }
          if type == .mouseMoved || type == .leftMouseDragged { return Unmanaged.passUnretained(event) }
          if engine.device.owner == nil { return Unmanaged.passUnretained(event) }
          let targeted = engine.currentTarget.map { engine.humanEventTargetsWindow(event, type, $0) } ?? false
          let origin = event.getIntegerValueField(.eventSourceUnixProcessID) > 0 ? "external-input" : "system-or-unclassified"
          let decision = inputIntervention(ownEvent: false, hasOwner: true, targetsWindow: targeted,
            escape: type == .keyDown && event.getIntegerValueField(.keyboardEventKeycode) == 53,
            foregroundRoute: engine.currentInputRoute == .foreground)
          switch decision {
          case .stop: engine.stopCurrentControl(reason: "target-escape", origin: origin)
          case .pause:
            engine.pauseCurrentControl(reason: targeted ? (type == .keyDown ? "target-keyboard" : "target-pointer") : "foreground-changed", origin: origin)
          case .ignore: break
          }
          return Unmanaged.passUnretained(event)
        }, userInfo: pointer)
    else { return }
    eventTap = tap
    eventSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    if let source = eventSource { CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes) }
    CGEvent.tapEnable(tap: tap, enable: true)
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
