// Modified by ZCode Feiyu contributors (2026).
import AppKit
import ApplicationServices
import Foundation

extension NativeEngine {
  func applicationAccessibilityWindows(_ app: NSRunningApplication)
    throws -> (windows: [AXUIElement], reason: String?)
  {
    guard AXIsProcessTrusted(), freshAccessibility else { return ([], "permission-denied") }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 0.25)
    let incarnation = accessibilityIncarnation(app)
    var preparationReason: String?
    if preparedAccessibilityIncarnations[incarnation] == nil {
      // Electron 结构树默认懒加载；只初始化已批准的当前进程，不在每帧重复切换或模拟 VoiceOver。
      // 官方机制是 setter；部分版本的属性枚举/settable 查询不声明该键，不能据此跳过。
      let result = AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
      if preparedAccessibilityIncarnations.count >= 256 { preparedAccessibilityIncarnations.removeAll() }
      if result == .success {
        // 官方 Electron 会延迟生成内容；接受 setter 不是就绪，重复设置反而会重置其计时器。
        preparedAccessibilityIncarnations[incarnation] = .initializing(
          until: DispatchTime.now().uptimeNanoseconds + 3_500_000_000)
      } else if result == .attributeUnsupported || result == .notImplemented {
        preparedAccessibilityIncarnations[incarnation] = .notRequired
      } else {
        preparationReason = result == .cannotComplete ? "accessibility-busy" : "accessibility-unavailable"
      }
    }
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(root, kAXWindowsAttribute as CFString, &value)
    if result == .cannotComplete { return ([], "accessibility-busy") }
    if result != .success { return ([], "accessibility-unavailable") }
    if case .initializing? = preparedAccessibilityIncarnations[incarnation] {
      preparationReason = "accessibility-initializing"
    }
    return (value as? [AXUIElement] ?? [], preparationReason)
  }
}
