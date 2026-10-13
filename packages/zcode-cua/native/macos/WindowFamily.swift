// Modified by ZCode Feiyu.
import AppKit
import ApplicationServices
import Darwin

enum NativeWindowIdentity {
  typealias Resolver = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
  static let resolver: Resolver? = {
    guard let handle = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY | RTLD_LOCAL),
      let symbol = dlsym(handle, "_AXUIElementGetWindow") else { return nil }
    return unsafeBitCast(symbol, to: Resolver.self)
  }()
  static func window(_ element: AXUIElement, pid: pid_t) -> CGWindowID? {
    var owner: pid_t = 0
    var id: CGWindowID = 0
    guard AXUIElementGetPid(element, &owner) == .success, owner == pid,
      resolver?(element, &id) == .success, id != 0 else { return nil }
    return id
  }
}

func accessibilityWindowFamily(_ app: NSRunningApplication, windows: [AXUIElement]) -> [AXUIElement] {
  let root = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(root, 0.15)
  var stack: [(AXUIElement, Int)] = windows.map { ($0, 0) }
  stack.append((root, 0))
  if let focused = axValue(root, kAXFocusedUIElementAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID() {
    stack.append((focused as! AXUIElement, 0))
  }
  var visited: [AXUIElement] = []
  var result: [AXUIElement] = []
  while let (element, depth) = stack.popLast(), visited.count < 128 {
    if visited.contains(where: { CFEqual($0, element) }) { continue }
    visited.append(element)
    AXUIElementSetMessagingTimeout(element, 0.1)
    let role = axString(element, kAXRoleAttribute)
    if ["AXWindow", "AXSheet", "AXDialog", "AXPopover", "AXMenu"].contains(role),
      NativeWindowIdentity.window(element, pid: app.processIdentifier) != nil { result.append(element) }
    guard depth < 4 else { continue }
    for attribute in ["AXSheets", "AXFocusedWindow", "AXParent"] {
      if let child = axValue(element, attribute), CFGetTypeID(child) == AXUIElementGetTypeID() { stack.append((child as! AXUIElement, depth + 1)) }
      if let children = axValue(element, attribute) as? [AXUIElement] { stack.append(contentsOf: children.prefix(32).map { ($0, depth + 1) }) }
    }
    if ["AXApplication", "AXMenuBar", "AXMenu", "AXMenuBarItem", "AXMenuItem"].contains(role) {
      var values: CFArray?
      var count: CFIndex = 0
      if AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count) == .success, count > 0, AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, min(count, 32), &values) == .success,
        let children = values as? [AXUIElement] { stack.append(contentsOf: children.map { ($0, depth + 1) }) }
    }
  }
  return result
}
