// Modified by ZCode Feiyu contributors (2026).
import AppKit
import ApplicationServices
import Foundation

enum ControlFeedbackPhase: String { case observing, active, waiting, paused }
struct ControlFeedbackAppearance {
  var captionSize = 13.0 // 对应 DESIGN.md 的默认 text-ui-caption；运行时由当前 UI token 覆盖。
  var foreground = NSColor.labelColor
  var background = NSColor.windowBackgroundColor
  var border = NSColor.separatorColor
  var accent = NSColor.labelColor
  var labels = ["observing": "Observing", "active": "Controlling", "waiting": "Waiting", "paused": "Paused"]
  init() {}
  init(_ value: [String: Any]) throws {
    let allowed = Set(["captionSize", "foreground", "background", "border", "accent", "labels"])
    guard Set(value.keys) == allowed else { throw ControlError("invalid_request", "Invalid control presentation fields") }
    captionSize = try finite(value["captionSize"], "captionSize")
    guard captionSize >= 8, captionSize <= 32 else { throw ControlError("invalid_request", "Invalid caption token") }
    func color(_ key: String) throws -> NSColor {
      guard let values = value[key] as? [Double], values.count == 4,
        values.allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= 1 }) else { throw ControlError("invalid_request", "Invalid presentation color") }
      return NSColor(srgbRed: values[0], green: values[1], blue: values[2], alpha: values[3])
    }
    foreground = try color("foreground"); background = try color("background")
    border = try color("border"); accent = try color("accent")
    guard let strings = value["labels"] as? [String: String], Set(strings.keys) == Set(labels.keys),
      strings.values.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.utf16.count <= 80 }) else { throw ControlError("invalid_request", "Invalid presentation labels") }
    labels = strings
  }
}
@MainActor private final class ControlFeedbackPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
  init(size: CGSize) {
    super.init(contentRect: CGRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    level = .normal
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
    isOpaque = false; backgroundColor = .clear; hasShadow = false
    ignoresMouseEvents = true; hidesOnDeactivate = false; isReleasedWhenClosed = false
    sharingType = .none
    setAccessibilityHidden(true)
  }
}
@MainActor private final class ControlFeedbackView: NSView {
  let pointer: Bool
  var palette = ControlFeedbackAppearance()
  var phase = ControlFeedbackPhase.observing
  var pressed = false
  var pressedUntil = 0.0
  var pulse = 0.0
  init(pointer: Bool, size: CGSize) {
    self.pointer = pointer
    super.init(frame: CGRect(origin: .zero, size: size))
    setAccessibilityElement(false)
  }
  required init?(coder: NSCoder) { fatalError("Programmatic control feedback") }
  override var isFlipped: Bool { true }
  override func draw(_ dirtyRect: NSRect) {
    if pointer {
      let shape = NSBezierPath()
      let points = [CGPoint(x: 3, y: 3), CGPoint(x: 3, y: 25), CGPoint(x: 9, y: 19), CGPoint(x: 14, y: 31), CGPoint(x: 20, y: 28), CGPoint(x: 14, y: 17), CGPoint(x: 24, y: 17)]
      shape.move(to: points[0]); points.dropFirst().forEach { shape.line(to: $0) }; shape.close()
      palette.background.setStroke(); shape.lineWidth = 3; shape.stroke()
      palette.accent.withAlphaComponent(phase == .paused ? 0.45 : 1).setFill(); shape.fill()
      let visiblePress = pressed || ProcessInfo.processInfo.systemUptime < pressedUntil
      let marker = NSBezierPath(ovalIn: CGRect(x: 21, y: 22, width: visiblePress ? 15 : 12, height: visiblePress ? 15 : 12))
      palette.background.setFill(); marker.fill(); palette.accent.setStroke(); marker.lineWidth = 1.5; marker.stroke()
      if phase == .waiting {
        let spinner = NSBezierPath(); spinner.appendArc(withCenter: CGPoint(x: 27, y: 28), radius: 3, startAngle: pulse * 360, endAngle: pulse * 360 + 250)
        spinner.lineWidth = 1.2; palette.accent.setStroke(); spinner.stroke()
      } else if phase == .paused {
        let bars = NSBezierPath(rect: CGRect(x: 24, y: 25, width: 2, height: 6)); bars.appendRect(CGRect(x: 28, y: 25, width: 2, height: 6)); palette.foreground.setFill(); bars.fill()
      } else { ("Z" as NSString).draw(at: CGPoint(x: 24, y: 23), withAttributes: [.font: NSFont.systemFont(ofSize: max(8, palette.captionSize - 3), weight: .semibold), .foregroundColor: palette.foreground]) }
      return
    }
    let capsule = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 6, yRadius: 6)
    palette.background.setFill(); capsule.fill(); palette.border.setStroke(); capsule.lineWidth = 1; capsule.stroke()
    let icon = NSBezierPath(roundedRect: CGRect(x: 8, y: 7, width: 12, height: 9), xRadius: 2, yRadius: 2)
    palette.accent.setStroke(); icon.lineWidth = 1.2; icon.stroke()
    let stem = NSBezierPath(); stem.move(to: CGPoint(x: 14, y: 16)); stem.line(to: CGPoint(x: 14, y: 19)); stem.move(to: CGPoint(x: 10, y: 19)); stem.line(to: CGPoint(x: 18, y: 19)); stem.stroke()
    let label = "ZCode · \(palette.labels[phase.rawValue] ?? phase.rawValue)" as NSString
    label.draw(at: CGPoint(x: 27, y: (bounds.height - palette.captionSize - 3) / 2), withAttributes: [.font: NSFont.systemFont(ofSize: palette.captionSize), .foregroundColor: palette.foreground])
    if phase == .waiting || phase == .active {
      let spinner = NSBezierPath()
      spinner.appendArc(withCenter: CGPoint(x: bounds.width - 11, y: bounds.midY), radius: 3, startAngle: pulse * 360, endAngle: pulse * 360 + 250)
      spinner.lineWidth = 1.2; palette.accent.setStroke(); spinner.stroke()
    } else if phase == .paused {
      let bars = NSBezierPath(rect: CGRect(x: bounds.width - 14, y: 9, width: 2, height: 8)); bars.appendRect(CGRect(x: bounds.width - 10, y: 9, width: 2, height: 8)); palette.foreground.setFill(); bars.fill()
    }
  }
}
@MainActor private final class ControlFeedbackBinding {
  let key: String
  let target: WindowTarget
  let gate: [String: Any]
  let application: [String: Any]
  let panel: ControlFeedbackPanel
  let view: ControlFeedbackView
  var frame: CGRect
  var revision = 0
  init(_ target: WindowTarget, _ operation: Operation, palette: ControlFeedbackAppearance) {
    key = operation.key; self.target = target; frame = target.frame
    gate = operation.authorizationGate; application = operation.application
    view = ControlFeedbackView(pointer: false, size: CGSize(width: 170, height: 26))
    view.palette = palette
    panel = ControlFeedbackPanel(size: view.bounds.size); panel.contentView = view
  }
  func close() { panel.orderOut(nil); panel.close() }
}
@MainActor final class NativeControlFeedback {
  private var bindings: [String: ControlFeedbackBinding] = [:]
  private var timer: Timer?
  private var lastGeometry = 0.0
  private var palette = ControlFeedbackAppearance()
  private var pointerPanel: ControlFeedbackPanel?
  private var pointerView: ControlFeedbackView?
  private var pointerBinding: String?
  private var pointerPosition: CGPoint?
  private var pointerAttached = true
  private var motionGeneration = 0
  private var revision = 0
  var windowIds: Set<CGWindowID> { Set((bindings.values.map { $0.panel } + (pointerPanel.map { [$0] } ?? [])).compactMap { $0.windowNumber > 0 ? CGWindowID($0.windowNumber) : nil }) }
  func ownsVisiblePoint(_ point: CGPoint) -> Bool {
    let height = CGDisplayBounds(CGMainDisplayID()).height
    return (bindings.values.map { $0.panel } + (pointerPanel.map { [$0] } ?? [])).contains { panel in
      panel.isVisible && appKitOverlayFrame(panel.frame, primaryHeight: height).contains(point)
    }
  }
  func configure(_ value: [String: Any]) throws {
    palette = try ControlFeedbackAppearance(value)
    for binding in bindings.values { binding.view.palette = palette; binding.view.needsDisplay = true }
    pointerView?.palette = palette; pointerView?.needsDisplay = true
  }
  func bind(_ target: WindowTarget, _ operation: Operation, phase: ControlFeedbackPhase = .observing) throws {
    let id = "\(operation.key):\(target.identity)"
    if bindings[id] == nil {
      // 显示引用有界；不能让长会话每次新目标无限创建桌面窗口。
      guard bindings.count < 32 else { throw ControlError("observation_limit", "Close unused native feedback targets before opening more windows") }
      bindings[id] = ControlFeedbackBinding(target, operation, palette: palette)
    }
    revision += 1; bindings[id]?.revision = revision
    bindings[id]?.view.phase = phase
    bindings[id]?.view.needsDisplay = true
    // 只读和语义动作也必须有代理身份；动作结束回到窗口左上角，不能停在旧点击位置。
    if phase != .active || pointerBinding == nil { attachPointer(id) }
    if pointerBinding == id { pointerView?.phase = phase; pointerView?.needsDisplay = true }
    if timer == nil {
      timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
        MainActor.assumeIsolated { self?.tick() }
      }
      if let timer { RunLoop.main.add(timer, forMode: .common) }
    }
    refresh()
  }
  func phase(_ target: WindowTarget, _ operation: Operation, _ phase: ControlFeedbackPhase) throws {
    try bind(target, operation, phase: phase)
    if pointerBinding == "\(operation.key):\(target.identity)" { pointerView?.phase = phase; pointerView?.needsDisplay = true }
  }
  func pause(_ key: String) {
    motionGeneration += 1
    for binding in bindings.values where binding.key == key { binding.view.phase = .paused; binding.view.needsDisplay = true }
    if let id = pointerBinding, bindings[id]?.key == key { pointerView?.phase = .paused; pointerView?.pressed = false; pointerView?.pressedUntil = 0; pointerView?.needsDisplay = true }
    if let id = pointerBinding, bindings[id]?.key == key { attachPointer(id); refresh() }
  }
  func remove(_ key: String, targetId: String? = nil) {
    for (id, binding) in bindings where binding.key == key && (targetId == nil || binding.target.identity == targetId) {
      if pointerBinding == id { hidePointer() }
      binding.close(); bindings.removeValue(forKey: id)
    }
    if bindings.isEmpty { timer?.invalidate(); timer = nil }
  }
  func dispose() {
    hidePointer(); timer?.invalidate(); timer = nil
    bindings.values.forEach { $0.close() }; bindings.removeAll()
    pointerPanel?.close(); pointerPanel = nil; pointerView = nil
  }
  private func hidePointer() {
    motionGeneration += 1; pointerBinding = nil; pointerPosition = nil
    pointerPanel?.orderOut(nil); pointerView?.pressed = false; pointerView?.pressedUntil = 0
  }
  func state(_ key: String) -> [String: Any] {
    let own = bindings.values.filter { $0.key == key }
    var value: [String: Any] = ["targets": own.map { ["targetId": $0.target.identity, "visible": $0.panel.isVisible, "phase": $0.view.phase.rawValue] }, "windowIds": Array(windowIds), "pointerVisible": pointerPanel?.isVisible ?? false]
    if let id = pointerBinding, bindings[id]?.key == key, let point = pointerPosition {
      value["pointer"] = ["x": point.x, "y": point.y, "pressed": pointerView?.pressed ?? false, "attached": pointerAttached]
    }
    return value
  }
  private func ensurePointer() {
    if pointerPanel == nil {
      let view = ControlFeedbackView(pointer: true, size: CGSize(width: 40, height: 42)); view.palette = palette
      let panel = ControlFeedbackPanel(size: view.bounds.size); panel.contentView = view
      pointerView = view; pointerPanel = panel
    }
  }
  private func attachPointer(_ id: String) {
    guard let binding = bindings[id] else { return }
    ensurePointer(); motionGeneration += 1
    pointerBinding = id; pointerAttached = true
    pointerPosition = CGPoint(x: binding.frame.minX + 47, y: binding.frame.minY + 12)
    pointerView?.phase = binding.view.phase; pointerView?.pressed = false; pointerView?.pressedUntil = 0
    pointerView?.needsDisplay = true
  }
  func pointer(_ point: CGPoint, target: WindowTarget, operation: Operation, pressed: Bool? = nil) {
    let id = "\(operation.key):\(target.identity)"
    guard bindings[id] != nil else { return }
    ensurePointer(); pointerAttached = false
    pointerBinding = id; pointerPosition = point; pointerView?.phase = .active
    if let pressed { pointerView?.pressed = pressed; if pressed { pointerView?.pressedUntil = ProcessInfo.processInfo.systemUptime + 0.12 } }
    pointerView?.needsDisplay = true; positionPointer()
  }
  func movePointer(to point: CGPoint, target: WindowTarget, operation: Operation) async throws {
    try phase(target, operation, .active)
    let previous = pointerBinding == "\(operation.key):\(target.identity)" ? pointerPosition : nil
    guard let previous else { pointer(point, target: target, operation: operation); return }
    motionGeneration += 1; let generation = motionGeneration
    let started = ProcessInfo.processInfo.systemUptime
    let motion = AgentPointerMotion(from: previous, to: point, started: started, duration: min(0.18, hypot(point.x - previous.x, point.y - previous.y) / 2400))
    repeat {
      try operation.check()
      guard motionGeneration == generation else { throw ControlError("cancelled", "Agent pointer was stopped") }
      let now = ProcessInfo.processInfo.systemUptime
      pointer(motion.position(at: now), target: target, operation: operation)
      if now - started >= motion.duration { return }
      try await Task.sleep(nanoseconds: 8_000_000)
    } while true
  }
  private func positionPointer() {
    guard let point = pointerPosition, let id = pointerBinding, let binding = bindings[id], binding.panel.isVisible,
      binding.frame.contains(point) else { pointerPanel?.orderOut(nil); return }
    let frame = CGRect(x: point.x - 3, y: point.y - 3, width: 40, height: 42)
    pointerPanel?.setFrame(appKitOverlayFrame(frame, primaryHeight: CGDisplayBounds(CGMainDisplayID()).height), display: false)
    // 与准确目标相对排序，遮挡不会销毁反馈引用，也不会浮在无关应用上方。
    pointerPanel?.level = binding.panel.level
    pointerPanel?.order(.above, relativeTo: binding.panel.windowNumber)
  }
  private func tick() {
    let now = ProcessInfo.processInfo.systemUptime
    if now - lastGeometry >= 0.1 { lastGeometry = now; refresh() }
    for binding in bindings.values where binding.view.phase == .waiting || binding.view.phase == .active {
      binding.view.pulse = now.truncatingRemainder(dividingBy: 1); binding.view.needsDisplay = true
    }
    if pointerView?.phase == .waiting { pointerView?.pulse = now.truncatingRemainder(dividingBy: 1); pointerView?.needsDisplay = true }
  }
  func refresh() {
    guard !bindings.isEmpty else { return }
    guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess(), let rows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { dispose(); return }
    // 同一物理窗口多个观察来源只投影一个标识，输入 owner 优先；不建立第二个输入租约。
    var displayed: [String: String] = [:]
    for (id, binding) in bindings {
      if let current = displayed[binding.target.identity], let previous = bindings[current] {
        if current == pointerBinding || (id != pointerBinding && previous.revision > binding.revision) { continue }
      }
      displayed[binding.target.identity] = id
    }
    let screens = NSScreen.screens.map { appKitOverlayFrame($0.frame, primaryHeight: CGDisplayBounds(CGMainDisplayID()).height) }
    for (id, binding) in bindings {
      guard !binding.target.app.isTerminated, (try? checkNativeAuthorization(binding.gate, binding.application)) != nil,
        let row = rows.first(where: { $0[kCGWindowNumber as String] as? UInt32 == binding.target.id && $0[kCGWindowOwnerPID as String] as? Int32 == binding.target.app.processIdentifier }),
        let bounds = row[kCGWindowBounds as String] as? [String: Any], let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary) else {
        if pointerBinding == id { hidePointer() }; binding.close(); bindings.removeValue(forKey: id); continue
      }
      let label = "ZCode · \(palette.labels[binding.view.phase.rawValue] ?? "")" as NSString
      let width = label.size(withAttributes: [.font: NSFont.systemFont(ofSize: palette.captionSize)]).width + 50
      let size = CGSize(width: min(280, max(110, width)), height: max(26, palette.captionSize + 13))
      if displayed[binding.target.identity] != id { binding.panel.orderOut(nil); continue }
      guard !binding.target.app.isHidden, row[kCGWindowIsOnscreen as String] as? Bool == true,
        let badge = controlBadgeFrame(window: frame, screens: screens, size: size, inset: 80) else { binding.panel.orderOut(nil); continue }
      if pointerBinding == id, let point = pointerPosition {
        // 附着箭头放在标识下方，避免覆盖 Mac 红黄绿按钮；点击穿透不能替代视觉避让。
        pointerPosition = pointerAttached
          ? CGPoint(x: badge.minX - 33, y: badge.maxY + 9)
          : CGPoint(x: point.x + frame.minX - binding.frame.minX, y: point.y + frame.minY - binding.frame.minY)
      }
      binding.frame = frame
      binding.view.frame = CGRect(origin: .zero, size: size)
      binding.panel.setFrame(appKitOverlayFrame(badge, primaryHeight: CGDisplayBounds(CGMainDisplayID()).height), display: true)
      binding.panel.level = NSWindow.Level(rawValue: row[kCGWindowLayer as String] as? Int ?? 0)
      binding.panel.order(.above, relativeTo: Int(binding.target.id))
    }
    positionPointer()
    if bindings.isEmpty { timer?.invalidate(); timer = nil }
  }
}
