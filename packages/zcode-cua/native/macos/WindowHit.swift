// Modified by ZCode Feiyu contributors (2026).
import AppKit
import ApplicationServices
import Foundation

extension NativeEngine {
  func windowReceivesPoint(_ point: CGPoint, _ target: WindowTarget) -> Bool? {
    windowHit(point, target).matches
  }
  func windowHit(_ point: CGPoint, _ target: WindowTarget)
    -> (matches: Bool?, details: [String: Any])
  {
    var details: [String: Any] = [
      "expectedWindowId": target.id, "expectedFrame": rectangle(target.frame),
      "point": ["x": point.x, "y": point.y],
      "foregroundPid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
    ]
    var element: AXUIElement?
    let result = AXUIElementCopyElementAtPosition(
      AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &element)
    var actualPid: pid_t?
    if result == .success, let element {
      var pid: pid_t = 0
      if AXUIElementGetPid(element, &pid) == .success {
        actualPid = pid
        details["hitPid"] = pid
        if pid != target.app.processIdentifier {
          if pid == ProcessInfo.processInfo.processIdentifier, feedback.ownsVisiblePoint(point) {
            actualPid = nil // 仅准确自有、可见且点击穿透的覆盖窗口可以排除。
          } else {
          if let window = axValue(element, kAXWindowAttribute),
            CFGetTypeID(window) == AXUIElementGetTypeID(),
            let frame = axFrame(window as! AXUIElement)
          {
            details["hitWindowFrame"] = rectangle(frame)
          }
          return (false, details)
          }
        }
      }
      if actualPid == target.app.processIdentifier, let window = axValue(element, kAXWindowAttribute),
        CFGetTypeID(window) == AXUIElementGetTypeID(), let expected = target.ax
      {
        let actual = window as! AXUIElement
        if let frame = axFrame(actual) { details["hitWindowFrame"] = rectangle(frame) }
        return (CFEqual(window, expected), details)
      }
      if let expected = target.ax, CFEqual(element, expected) { return (true, details) }
    }
    guard
      let windows = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
    else { return (nil, details) }
    for row in windows {
      // 自有反馈层点击穿透；只排除当前 controller 的准确窗口 ID。
      if let id = row[kCGWindowNumber as String] as? UInt32, feedback.windowIds.contains(id) { continue }
      guard (row[kCGWindowLayer as String] as? Int ?? -1) >= 0,
        (row[kCGWindowAlpha as String] as? Double ?? 1) > 0,
        let bounds = row[kCGWindowBounds as String] as? [String: Any],
        let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary), frame.contains(point),
        let pid = row[kCGWindowOwnerPID as String] as? Int32
      else { continue }
      // AX 已确认实际接收应用时，其他进程的透明外接矩形不是输入目标。
      if let actualPid, pid != actualPid { continue }
      details["hitPid"] = pid
      details["hitWindowId"] = row[kCGWindowNumber as String]
      details["hitWindowFrame"] = rectangle(frame)
      return (
        pid == target.app.processIdentifier
          && row[kCGWindowNumber as String] as? UInt32 == target.id, details
      )
    }
    return (nil, details)
  }
}
