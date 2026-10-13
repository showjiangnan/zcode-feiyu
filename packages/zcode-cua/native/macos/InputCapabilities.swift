// Modified by ZCode Feiyu.
import AppKit
import ApplicationServices

extension NativeEngine {
  func inputCapabilities(_ target: WindowTarget) -> [String: Any] {
    let permission = freshAccessibility && AXIsProcessTrusted() && sessionActive
    let focusedWindow = axValue(AXUIElementCreateApplication(target.app.processIdentifier), kAXFocusedWindowAttribute)
    let sameFocusedWindow = target.ax.map { ax in focusedWindow.map { CFEqual(ax, $0) } ?? false } ?? false
    let otherWindow = target.app.isActive && target.ax != nil && focusedWindow != nil && !sameFocusedWindow
    let mouse = permission && WindowEventCoordinates.setter != nil && !otherWindow
    let value = axValue(AXUIElementCreateApplication(target.app.processIdentifier), kAXFocusedUIElementAttribute)
    let focused: AXUIElement? = value.flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
    let focusMatches = focused.flatMap { axValue($0, kAXWindowAttribute) }.map { window in target.ax.map { CFEqual($0, window) } ?? false } ?? false
    let protected = focused.map { axString($0, kAXSubroleAttribute) == kAXSecureTextFieldSubrole } ?? false
    return ["schemaVersion": 1,
      "isolated": [
        "mouse": ["status": mouse ? "conditional" : "unavailable", "reason": !permission ? "permission-or-desktop-unavailable" : otherWindow ? "same-application-other-window-focused" : WindowEventCoordinates.setter == nil ? "window-coordinates-unavailable" : "application-must-accept-targeted-events"],
        "keyboard": ["status": permission && focusMatches && !protected && !otherWindow ? "conditional" : "unavailable", "reason": protected ? "protected-input" : !focusMatches ? "no-verified-text-focus" : otherWindow ? "same-application-other-window-focused" : "application-must-accept-targeted-events"]],
      "semantic": ["status": permission && target.ax != nil ? "element-dependent" : "unavailable"],
      "foreground": ["status": permission ? "available" : "unavailable", "requiresExplicitActivation": true]]
  }
}
