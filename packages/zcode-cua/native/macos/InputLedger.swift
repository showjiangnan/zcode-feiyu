// Modified by ZCode Feiyu contributors (2026).
import AppKit
import ApplicationServices
import Foundation

struct NativeInputRelease {
  let event: CGEvent
  let modifiers: CGEventFlags
  var submitted: Bool
  let isolatedPid: pid_t?
  let incarnation: String
}
func nativeInputNeutral() -> Bool {
  (0..<128).allSatisfy { !CGEventSource.keyState(.combinedSessionState, key: CGKeyCode($0)) }
    && !CGEventSource.buttonState(.combinedSessionState, button: .left)
    && !CGEventSource.buttonState(.combinedSessionState, button: .right)
    && !CGEventSource.buttonState(.combinedSessionState, button: .center)
}
extension NativeEngine {
  func recordInput(_ event: CGEvent, target: WindowTarget) throws {
    reconcileInputReleases()
    let keyboard = event.type == .keyDown || event.type == .keyUp
    let down =
      event.type == .keyDown || event.type == .leftMouseDown
      || event.type == .rightMouseDown || event.type == .otherMouseDown
    let up =
      event.type == .keyUp || event.type == .leftMouseUp
      || event.type == .rightMouseUp || event.type == .otherMouseUp
    guard down || up else { return }
    let key =
      keyboard
      ? Int(event.getIntegerValueField(.keyboardEventKeycode))
      : 128 + Int(event.getIntegerValueField(.mouseEventButtonNumber))
    if down {
      guard var release = event.copy() else {
        throw ControlError("event_creation_failed", "Native release event could not be retained")
      }
      release.type =
        keyboard
        ? .keyUp
        : event.type == .leftMouseDown
          ? .leftMouseUp
          : event.type == .rightMouseDown ? .rightMouseUp : .otherMouseUp
      release.flags = []
      if currentInputRoute == .isolated && !keyboard {
        // 只改 CG type 会保留 NSEvent 的 down 元数据；取消时需重新合成同编号的 up。
        release = try isolatedEvent(release, target)
        stampTarget(release, target)
      }
      let mask: CGEventFlags = [.maskCommand, .maskControl, .maskAlternate, .maskShift]
      inputReleases[key] = NativeInputRelease(
        event: release, modifiers: keyboard ? event.flags.intersection(mask) : [], submitted: false,
        isolatedPid: currentInputRoute == .isolated ? target.app.processIdentifier : nil, incarnation: target.incarnation)
    } else if var entry = inputReleases[key] {
      entry.submitted = true
      inputReleases[key] = entry
    }
  }
  func reconcileInputReleases() {
    for (key, entry) in inputReleases where entry.submitted {
      // 定向事件不写系统键鼠状态；自身 release 不应被用户的物理按键误判为仍然持有。
      if entry.isolatedPid != nil { inputReleases.removeValue(forKey: key); continue }
      let released: Bool
      if key < 128 {
        released =
          !CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(key))
          && CGEventSource.flagsState(.combinedSessionState).intersection(entry.modifiers).isEmpty
      } else {
        released = !CGEventSource.buttonState(
          .combinedSessionState, button: CGMouseButton(rawValue: UInt32(key - 128)) ?? .left)
      }
      if released { inputReleases.removeValue(forKey: key) }
    }
  }
  func releaseTrackedInput() -> Bool {
    for (key, var entry) in inputReleases where !entry.submitted {
      entry.event.setIntegerValueField(.eventSourceUserData, value: nativeEventTag)
      if let pid = entry.isolatedPid {
        if let app = NSRunningApplication(processIdentifier: pid), accessibilityIncarnation(app) == entry.incarnation {
          entry.event.postToPid(pid)
        }
      } else {
        if key >= 128 { entry.event.location = CGEvent(source: nil)?.location ?? .zero }
        entry.event.post(tap: .cghidEventTap)
      }
      entry.submitted = true
      inputReleases[key] = entry
    }
    // 投递 up 不等于系统已释放；只有本账本的输入状态回到中立才清除持久阻断。
    let deadline = DispatchTime.now().uptimeNanoseconds + 50_000_000
    repeat {
      reconcileInputReleases()
      if inputReleases.isEmpty { return true }
      Thread.sleep(forTimeInterval: 0.001)
    } while DispatchTime.now().uptimeNanoseconds < deadline
    return false
  }
}
