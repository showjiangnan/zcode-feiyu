// Modified by ZCode Feiyu.
import AppKit
import ApplicationServices
import Foundation

extension NativeEngine {
  func targetStatus(_ input: [String: Any], contextKey: String) throws -> [String: Any] {
    let expected = try requiredString(input["targetId"], "targetId")
    let pid = try finite(input["pid"], "pid")
    let number = try finite(input["windowId"], "windowId")
    guard pid > 0, pid <= Double(Int32.max), pid.rounded() == pid,
      number > 0, number <= Double(UInt32.max), number.rounded() == number else {
      throw ControlError("invalid_request", "Invalid registered target identity")
    }
    let closed: [String: Any] = ["targetId": expected, "status": "closed"]
    guard let app = NSRunningApplication(processIdentifier: Int32(pid)), !app.isTerminated,
      expected == "\(accessibilityIncarnation(app)):\(UInt32(number))" else { return closed }
    guard let rows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
      throw ControlError("target_unavailable", "Window server state is unavailable")
    }
    // 不使用 onscreen 判断关闭：最小化/遮挡时窗口身份仍然有效。
    guard let row = rows.first(where: { $0[kCGWindowOwnerPID as String] as? Int32 == app.processIdentifier && $0[kCGWindowNumber as String] as? UInt32 == UInt32(number) }) else { return closed }
    if row[kCGWindowIsOnscreen as String] as? Bool != true, !app.isHidden {
      // AppKit 可以保留已关闭 NSWindow 的 CG 记录；核对真实 AX 身份，不能误删最小化窗口。
      if AXIsProcessTrusted(), freshAccessibility, let ax = observations["\(contextKey):\(expected)"]?.target.ax {
        AXUIElementSetMessagingTimeout(ax, 0.15)
        var role: CFTypeRef?
        if AXUIElementCopyAttributeValue(ax, kAXRoleAttribute as CFString, &role) == .invalidUIElement { return closed }
      }
      let enumeration = try applicationAccessibilityWindows(app)
      let ids = enumeration.reason == nil ? enumeration.windows.map { NativeWindowIdentity.window($0, pid: app.processIdentifier) } : nil
      let minimized = enumeration.windows.contains { axValue($0, kAXMinimizedAttribute) as? Bool == true }
      // CGWindow.h 明确约定该可选键缺失表示未上屏，而非未知状态。
      if registeredWindowClosed(onScreen: row[kCGWindowIsOnscreen as String] as? Bool ?? false,
        applicationHidden: app.isHidden, knownWindowIds: ids, target: UInt32(number),
        layer: row[kCGWindowLayer as String] as? Int ?? 0, minimizedRoot: minimized) { return closed }
    }
    return ["targetId": expected, "status": "present"]
  }
  func previewTarget(_ input: [String: Any]) throws -> WindowTarget {
    guard let expected = input["targetId"] as? String, let number = input["windowId"] else { return try target(input) }
    let app = try application(input)
    let id = try finite(number, "windowId")
    guard id > 0, id <= Double(UInt32.max), id.rounded() == id,
      expected == "\(accessibilityIncarnation(app)):\(UInt32(id))" else { throw ControlError("stale_target", "Preview target identity changed") }
    // 只读预览不需要重建 AX；仍逐帧核对同一进程、窗口和实际几何，绝不按标题猜配。
    guard let rows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
      let row = rows.first(where: { $0[kCGWindowOwnerPID as String] as? Int32 == app.processIdentifier && $0[kCGWindowNumber as String] as? UInt32 == UInt32(id) }),
      row[kCGWindowIsOnscreen as String] as? Bool == true,
      let bounds = row[kCGWindowBounds as String] as? [String: Double], let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
      frame.width > 1, frame.height > 1 else { throw ControlError("target_unavailable", "Preview window is unavailable") }
    return WindowTarget(app: app, id: UInt32(id), frame: frame, title: row[kCGWindowName as String] as? String ?? "", ax: nil,
      structureReason: "presentation-image-only", layer: row[kCGWindowLayer as String] as? Int ?? 0)
  }
}
