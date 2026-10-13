// Modified by ZCode Feiyu.
import Foundation
import ApplicationServices

extension NativeEngine {
  func readText(_ target: WindowTarget, _ input: [String: Any], _ operation: Operation) throws -> [String: Any] {
    guard freshAccessibility && AXIsProcessTrusted() else { throw ControlError("permission_revoked", "Accessibility permission is required") }
    let field = input["field"] as? String ?? "value"
    guard ["label", "value"].contains(field) else { throw ControlError("invalid_request", "Invalid text field") }
    let observation = try freshObservation(target, input, operation)
    let node = try element(input, observation)
    guard node.json["secure"] as? Bool != true else { throw ControlError("protected_input", "Protected text cannot be read") }
    let offset = try finite(input["offset"], "offset", default: 0)
    let length = try finite(input["length"], "length", default: 4096)
    guard offset >= 0, offset <= 4_000_000, length >= 1, length <= 65536,
      offset.rounded() == offset, length.rounded() == length else { throw ControlError("invalid_request", "Invalid text range") }
    try operation.check()
    AXUIElementSetMessagingTimeout(node.element, 0.15)
    // AX 查询失败不等于空文本，尤其不能将安全状态查询失败当成普通输入。
    guard try checkedAccessibilityText(node.element, kAXSubroleAttribute, optional: true) != kAXSecureTextFieldSubrole else { throw ControlError("protected_input", "Protected text cannot be read") }
    var value = ""
    if field == "label" {
      for attribute in [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute] {
        value = try checkedAccessibilityText(node.element, attribute, optional: true)
        if !value.isEmpty { break }
      }
    } else { value = try checkedAccessibilityText(node.element, kAXValueAttribute) }
    guard value.utf16.count <= 4_000_000 else { throw ControlError("text_limit", "Text exceeds the bounded range reader") }
    let slice = textSlice(value, offset: Int(offset), length: Int(length))
    try operation.check()
    _ = try freshObservation(target, input, operation)
    var result: [String: Any] = ["elementId": input["elementId"]!, "observationId": observation.id,
      "text": slice.text, "field": field, "start": slice.start, "end": slice.end, "totalLength": slice.total,
      "truncated": slice.end < slice.total, "unit": "utf16"]
    if slice.end < slice.total { result["nextOffset"] = slice.end }
    return result
  }
}
