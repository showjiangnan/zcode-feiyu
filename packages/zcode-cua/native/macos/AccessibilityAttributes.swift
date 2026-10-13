// Modified by ZCode Feiyu.
import ApplicationServices
import Foundation

func observationAttributes(_ element: AXUIElement) throws -> [String: CFTypeRef] {
  // 逐项 AX 查询会放大繁忙 provider 的阻塞；批量读取并显式保留失败事实。
  // value 必须在确认非安全输入后单独读取，不能通过批量请求泄漏密码字段。
  let names = [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute,
    kAXSubroleAttribute, kAXEnabledAttribute, kAXFocusedAttribute]
  var values: CFArray?
  let result = AXUIElementCopyMultipleAttributeValues(element, names as CFArray, [], &values)
  guard result == .success, let rows = values as? [CFTypeRef], rows.count == names.count else {
    throw ControlError("accessibility_busy", "Accessibility attributes are not ready")
  }
  var fields: [String: CFTypeRef] = [:]
  for (name, value) in zip(names, rows) {
    if CFGetTypeID(value) == AXValueGetTypeID(), AXValueGetType(value as! AXValue) == .axError {
      var error = AXError.success
      AXValueGetValue(value as! AXValue, .axError, &error)
      if error == .cannotComplete { throw ControlError("accessibility_busy", "Accessibility provider is busy") }
      if error != .attributeUnsupported && error != .noValue { throw ControlError("structure_unavailable", "Accessibility metadata is unavailable") }
      continue
    }
    fields[name] = value
  }
  guard let role = fields[kAXRoleAttribute] as? String, !role.isEmpty else {
    throw ControlError("structure_unavailable", "Accessibility role is unavailable")
  }
  return fields
}

func checkedAccessibilityText(_ element: AXUIElement, _ attribute: String, optional: Bool = false) throws -> String {
  var value: CFTypeRef?
  let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
  if result == .noValue || (optional && result == .attributeUnsupported) { return "" }
  guard result == .success else {
    throw ControlError(result == .cannotComplete ? "accessibility_busy" : result == .invalidUIElement ? "stale_element" : "text_unsupported", "Accessibility text could not be read")
  }
  let text = (value as? String) ?? (value as? NSNumber)?.stringValue ?? ""
  guard text.utf16.count <= 4_000_000 else { throw ControlError("text_limit", "Text exceeds the bounded range reader") }
  return text
}
