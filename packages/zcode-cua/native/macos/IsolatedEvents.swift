// Modified by ZCode Feiyu contributors (2026).
import AppKit
import ApplicationServices
import Darwin

enum WindowEventCoordinates {
  typealias Setter = @convention(c) (CGEvent, CGPoint) -> Void
  static let setter: Setter? = {
    guard let handle = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_LAZY | RTLD_LOCAL),
      let symbol = dlsym(handle, "CGEventSetWindowLocation") else { return nil }
    return unsafeBitCast(symbol, to: Setter.self)
  }()
}

extension NativeEngine {
  func isolatedEvent(_ source: CGEvent, _ target: WindowTarget) throws -> CGEvent {
    let mouseTypes: [CGEventType] = [.leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged]
    guard mouseTypes.contains(source.type) || source.type == .scrollWheel else { return source }
    guard let setLocal = WindowEventCoordinates.setter else {
      throw ControlError("input_mode_unavailable", "Isolated mouse input requires native window event coordinates")
    }
    let point = source.location
    let local = CGPoint(x: point.x - target.frame.minX, y: point.y - target.frame.minY)
    var event = source
    if mouseTypes.contains(source.type) {
      let button = source.getIntegerValueField(.mouseEventButtonNumber)
      let release = [.leftMouseUp, .rightMouseUp, .otherMouseUp].contains(source.type) ? inputReleases[128 + Int(button)]?.event : nil
      let sourceNumber = Int(source.getIntegerValueField(.mouseEventNumber))
      let number = release.map { Int($0.getIntegerValueField(.mouseEventNumber)) } ?? (sourceNumber > 0 ? sourceNumber : nextWindowEventNumber())
      let count = release?.getIntegerValueField(.mouseEventClickState) ?? source.getIntegerValueField(.mouseEventClickState)
      guard let type = NSEvent.EventType(rawValue: UInt(source.type.rawValue)),
        let cocoa = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
          timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: Int(target.id), context: nil,
          eventNumber: number, clickCount: Int(count), pressure: 1),
        let converted = cocoa.cgEvent else { throw ControlError("event_creation_failed", "Cannot create a window-targeted Cocoa mouse event") }
      event = converted
      event.setIntegerValueField(.mouseEventButtonNumber, value: source.getIntegerValueField(.mouseEventButtonNumber))
      event.setIntegerValueField(.mouseEventSubtype, value: 3)
    }
    // 裸 CGEvent 缺少 Cocoa 窗口局部坐标，定向投递后仍会被接收窗口忽略。
    // 保留 NSEvent 元数据并分别写屏幕/窗口坐标，焦点由独立的内部通知管理。
    event.location = point
    event.flags = source.flags
    if source.type == .scrollWheel {
      // 滚轮没有 NSEvent 鼠标工厂自动写入的窗口编号；原生滚轮构造路径需补字段 51。
      event.setIntegerValueField(CGEventField(rawValue: 51)!, value: Int64(target.id))
    }
    setLocal(event, local)
    return event
  }
  func nextWindowEventNumber() -> Int {
    windowEventNumber = windowEventNumber == Int.max ? 1 : windowEventNumber + 1
    return windowEventNumber
  }
  func enforceSyntheticWindowFocus(_ target: WindowTarget, _ operation: Operation) throws {
    try operation.check()
    if currentInputRoute == .isolated, target.app.isActive, let window = target.ax,
      let focused = axValue(AXUIElementCreateApplication(target.app.processIdentifier), kAXFocusedWindowAttribute), !CFEqual(window, focused) {
      throw ControlError("input_mode_unavailable", "Another window of this application has user focus; use semantic actions or explicit foreground input")
    }
    if let previous = syntheticFocusTarget {
      if previous.identity == target.identity { return }
      restoreSyntheticFocus()
    }
    guard currentInputRoute == .isolated, !target.app.isActive else { return }
    syntheticFocusTarget = target
    // 应用内部输入焦点与 WindowServer 的真实前台分离；参考原生事件使用这两个
    // AppKit 通知和窗口焦点通知，不调用 activate/AXRaise 或改变用户光标。
    guard let event = NSEvent.otherEvent(with: .appKitDefined, location: .zero,
      modifierFlags: NSEvent.ModifierFlags(rawValue: 0xC0000),
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: Int(target.id),
      context: nil, subtype: 1, data1: 0, data2: 0)?.cgEvent else {
      throw ControlError("event_creation_failed", "Cannot create isolated application focus")
    }
    stampTarget(event, target); event.postToPid(target.app.processIdentifier)
    if let type = NSEvent.EventType(rawValue: 21), let focus = NSEvent.otherEvent(with: type, location: .zero, modifierFlags: [],
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: 0, context: nil,
      subtype: Int16(bitPattern: 0x8000), data1: 0, data2: 0)?.cgEvent {
      stampTarget(focus, target); focus.postToPid(target.app.processIdentifier)
    }
  }
  func restoreSyntheticFocus() {
    guard let target = syntheticFocusTarget else { return }
    syntheticFocusTarget = nil
    guard let app = NSRunningApplication(processIdentifier: target.app.processIdentifier), !app.isTerminated, !app.isActive,
      accessibilityIncarnation(app) == target.incarnation,
      let event = NSEvent.otherEvent(with: .appKitDefined, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: 0, context: nil, subtype: 2, data1: 0, data2: 0)?.cgEvent else { return }
    stampTarget(event, target); event.postToPid(target.app.processIdentifier)
    if let type = NSEvent.EventType(rawValue: 21), let focus = NSEvent.otherEvent(with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
      windowNumber: 0, context: nil, subtype: 0x4000, data1: 0, data2: 0)?.cgEvent {
      stampTarget(focus, target); focus.postToPid(target.app.processIdentifier)
    }
  }
}
