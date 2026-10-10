// Modified by ZCode Feiyu contributors (2026).
import AppKit
import ApplicationServices
import Foundation

enum AccessibilityPreparation {
  case notRequired
  case initializing(until: UInt64)
  case ready
}

func accessibilityIncarnation(_ app: NSRunningApplication) -> String {
  "\(app.processIdentifier):\(app.launchDate?.timeIntervalSince1970 ?? 0):\(app.executableURL?.resolvingSymlinksInPath().path ?? "")"
}

func hasWebAccessibilityContent(_ root: AXUIElement, _ operation: Operation) throws -> Bool {
  var remaining = 128
  var stack = [root]
  var visited: [AXUIElement] = []
  while let element = stack.popLast(), remaining > 0 {
    try operation.check()
    if visited.contains(where: { CFEqual($0, element) }) { continue }
    visited.append(element)
    remaining -= 1
    AXUIElementSetMessagingTimeout(element, 0.15)
    if axString(element, kAXRoleAttribute) == "AXWebArea" { return true }
    var count: CFIndex = 0
    guard AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count)
      == .success, count > 0, remaining > 0 else { continue }
    var children: CFArray?
    if AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0,
      min(count, remaining), &children) == .success, let children = children as? [AXUIElement] {
      stack.append(contentsOf: children.reversed())
    }
  }
  return false
}

extension NativeEngine {
  func qualifyAccessibilityInitialization(_ operation: Operation) throws {
    try operation.check()
    guard sessionActive else { throw ControlError("locked", "Desktop became unavailable during initialization") }
    guard !stopped.contains(operation.key) else { throw ControlError("turn_stopped", "Computer control was stopped") }
    guard freshAccessibility, AXIsProcessTrusted() else {
      throw ControlError("accessibility_denied", "Accessibility permission changed during initialization")
    }
  }
  func waitForAccessibilityWindowBinding(_ window: WindowTarget, _ operation: Operation) async throws -> WindowTarget {
    guard window.ax == nil,
      case .initializing(let until)? = preparedAccessibilityIncarnations[window.incarnation]
      else { return window }
    // Kiro 启动时 CG 窗口先出现；没有 AX 绑定也要等待同一初始化，不能误称不支持。
    let current: WindowTarget? = try await waitForAccessibilityReadiness(
      until: until, revision: { self.changeSequence },
      qualify: { try self.qualifyAccessibilityInitialization(operation) },
      probe: {
        guard let candidate = try self.targets(window.app).first(where: { $0.id == window.id }),
          candidate.identity == window.identity, candidate.frame.equalTo(window.frame)
          else { throw ControlError("inconsistent_observation", "Window changed during accessibility initialization") }
        return candidate.ax == nil ? nil : candidate
      })
    return current ?? window
  }
  func waitForAccessibilityContent(_ window: WindowTarget, _ operation: Operation) async throws -> Bool {
    let key = window.incarnation
    guard case .initializing(let until)? = preparedAccessibilityIncarnations[key], let root = window.ax
      else { return true }
    let ready: Bool? = try await waitForAccessibilityReadiness(
      until: until, revision: { self.changeSequence },
      qualify: { try self.qualifyAccessibilityInitialization(operation) },
      probe: {
        let available = try await Task.detached(priority: .userInitiated) {
          try hasWebAccessibilityContent(root, operation)
        }.value
        return available ? true : nil
      })
    if ready == true { preparedAccessibilityIncarnations[key] = .ready }
    return ready == true
  }
}
