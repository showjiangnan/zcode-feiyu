// Modified by ZCode Feiyu contributors (2026).
import AppKit
import ApplicationServices
import Foundation

enum NativeInputRoute: String { case isolated, foreground }
extension NativeEngine {
  func inputRoute(_ input: [String: Any], method: String) throws -> NativeInputRoute {
    if method == "activate" { return .foreground }
    let mode = input["inputMode"] as? String ?? "isolated"
    guard let route = NativeInputRoute(rawValue: mode) else { throw ControlError("invalid_request", "Invalid inputMode") }
    return route
  }
  func verifyInputTarget(_ target: WindowTarget, _ operation: Operation) throws {
    try operation.check()
    guard sessionActive, !stopped.contains(operation.key), !focusBlocked.contains(operation.key), device.owner == operation.key,
      !target.app.isTerminated else { throw ControlError("foreground_required", "Control ownership or target changed") }
    let current = try self.target(target.json)
    guard current.identity == target.identity, current.frame.equalTo(target.frame) else { throw ControlError("stale_target", "Window identity or geometry changed") }
    if currentInputRoute == .foreground,
      NSWorkspace.shared.frontmostApplication?.processIdentifier != target.app.processIdentifier {
      throw ControlError("foreground_required", "Input target no longer has foreground focus")
    }
  }
  func verifyPointerTarget(_ point: CGPoint, _ target: WindowTarget) throws {
    if currentInputRoute == .foreground { try verifyHit(point, target); return }
    // 定向输入复核应用自身的窗口，不以用户桌面的最上层窗口猜测接收者。
    guard target.frame.contains(point) else { throw ControlError("out_of_bounds", "Point is outside the bound window") }
    if let ax = target.ax {
      var hit: AXUIElement?
      let result = AXUIElementCopyElementAtPosition(AXUIElementCreateApplication(target.app.processIdentifier), Float(point.x), Float(point.y), &hit)
      if result == .success, let hit {
        var pid: pid_t = 0
        guard AXUIElementGetPid(hit, &pid) == .success, pid == target.app.processIdentifier else { throw ControlError("stale_target", "Isolated point resolved to another process") }
        if CFEqual(hit, ax) { return }
        if let window = axValue(hit, kAXWindowAttribute), CFGetTypeID(window) == AXUIElementGetTypeID() {
          guard CFEqual(window, ax) else { throw ControlError("modal_active", "A different application window or modal receives this point") }
          return
        }
      }
    }
    // 自绘/image-only 应用没有 AX 控件不代表不能定向投递。参考窗口事件的准确 PID/window
    // 路由，按同进程窗口栈复核；拒绝同应用弹层，不把其他应用/Dock 的外接矩形当接收者。
    guard let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { throw ControlError("hit_test_unavailable", "Cannot verify the isolated window stack") }
    let windows: [(id: CGWindowID, frame: CGRect)] = rows.compactMap { row in
      guard row[kCGWindowOwnerPID as String] as? Int32 == target.app.processIdentifier,
        (row[kCGWindowLayer as String] as? Int ?? -1) >= 0,
        (row[kCGWindowAlpha as String] as? Double ?? 1) > 0,
        let id = row[kCGWindowNumber as String] as? UInt32,
        let bounds = row[kCGWindowBounds as String] as? [String: Any],
        let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return nil }
      return (id, frame)
    }
    guard let recipient = isolatedPointWindow(point, windows: windows) else { throw ControlError("target_unavailable", "The isolated target is not visible on its desktop") }
    guard recipient == target.id else { throw ControlError("modal_active", "Another window of this application receives this point") }
  }
  func stampTarget(_ event: CGEvent, _ target: WindowTarget) {
    event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(target.app.processIdentifier))
    event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(target.id))
    event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(target.id))
    event.setIntegerValueField(.eventSourceUserData, value: nativeEventTag)
  }
}
