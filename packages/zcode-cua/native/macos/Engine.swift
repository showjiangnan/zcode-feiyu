// Modified by ZCode Feiyu.
import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit

@MainActor final class NativeEngine {
  let cancellations: CancellationRegistry
  let device = DeviceLease()
  let feedback = NativeControlFeedback()
  var currentInputRoute = NativeInputRoute.isolated
  var observations: [String: Observation] = [:]
  var inputReleases: [Int: NativeInputRelease] = [:]
  var stopped = Set<String>()
  var focusBlocked = Set<String>()
  var sessionActive = true
  var eventTap: CFMachPort?
  var managedEventTap: ManagedEventTap?
  var eventSource: CFRunLoopSource?
  var observers: [NSObjectProtocol] = []
  var activeOperation: Operation?
  var currentTarget: WindowTarget?
  var controlContext: [String: Any]?
  var freshAccessibility = false
  var freshScreenCapture = false
  var postedSegments = 0
  var windowEventNumber = 0
  var taggedGlobalPointerEvents = 0
  var syntheticFocusTarget: WindowTarget?
  var changeObservers: [pid_t: AXObserver] = [:]
  var changeTargets: [String: WindowTarget] = [:]
  var changeSequence = 0
  var preparedAccessibilityIncarnations: [String: AccessibilityPreparation] = [:]
  var lastChange: UInt64 = 0
  var onControlEvent: (([String: Any]) -> Void)?
  var shareableContentTask: Task<SCShareableContent, Error>?
  var previewCaptures: [String: PreviewCapture] = [:]
  var previewClosing: [ObjectIdentifier: Int] = [:]
  var previewVisibleKeys: Set<String>?
  var previewVisibilityRevision = -1.0
  init(_ cancellations: CancellationRegistry) { self.cancellations = cancellations }
  func permissionStatus() -> [String: Any] {
    let ax = AXIsProcessTrusted()
    let screen = CGPreflightScreenCaptureAccess()
    return [
      "platform": "darwin", "grant_owner": "dev.zcode.cua-helper",
      "owner": ["display_name": "ZCode Computer Use"], "accessibility": ax ? "granted" : "denied",
      "accessibility_probe_ok": ax, "screen_recording": screen ? "granted" : "denied",
      "interactiveDesktop": sessionActive, "minimumOSVersion": "14.4",
      "protocolVersion": protocolVersion,
    ]
  }
  func admit(_ operation: Operation, _ input: [String: Any], mutation: Bool = false, requireNeutral: Bool = false) throws {
    try operation.check()
    guard operation.context["runtimeScope"] as? String == "main",
      operation.context["sessionId"] is String, operation.context["turnId"] is String,
      input["approved"] as? Bool == true
    else {
      throw ControlError("not_authorized", "Trusted main-task application approval is required")
    }
    guard sessionActive else {
      throw ControlError("locked", "The interactive desktop is unavailable")
    }
    if stopped.contains(operation.key) {
      throw ControlError("turn_stopped", "Computer control was stopped for this turn")
    }
    if mutation {
      guard activeOperation == nil else {
        throw ControlError("device_busy", "A native input action is already running")
      }
      guard AXIsProcessTrusted(), freshAccessibility else {
        throw ControlError(
          "accessibility_denied", "Grant Accessibility permission to ZCode Computer Use")
      }
      if focusBlocked.contains(operation.key) {
        throw ControlError(
          "foreground_required", "User changed focus; explicitly continue computer control")
      }
      if requireNeutral && !nativeInputNeutral() {
        throw ControlError("foreground_required", "Release physical keys and mouse buttons before foreground input")
      }
      // 物理输入不满足前台准入时先拒绝，避免失败请求留下新租约。
      try device.acquire(operation.key, requireNeutral: requireNeutral)
      controlContext = operation.context
      installStopMonitor()
      guard let eventTap, CGEvent.tapIsEnabled(tap: eventTap) else {
        device.release(operation.key)
        throw ControlError("stop_monitor_unavailable", "Native user-stop monitoring is unavailable")
      }
    }
  }
  func handle(_ method: String, _ params: [String: Any], id: String) async throws -> [String: Any] {
    let duration = try finite(params["deadlineMs"], "deadlineMs", default: 30_000)
    guard duration > 0, duration <= 120_000 else {
      throw ControlError("invalid_request", "Invalid operation deadline")
    }
    let operation = Operation(
      id: id, context: record(params["context"]),
      deadline: DispatchTime.now().uptimeNanoseconds + UInt64(duration * 1_000_000),
      cancellations: cancellations, authorizationGate: record(params["authorizationGate"]),
      application: record(params["application"]))
    defer { cancellations.remove(id) }
    let input = record(params["input"] ?? params)
    if let presentation = params["presentation"] as? [String: Any] { try feedback.configure(presentation) }
    freshAccessibility = params["freshAccessibility"] as? Bool ?? AXIsProcessTrusted()
    freshScreenCapture = params["freshScreenCapture"] as? Bool ?? CGPreflightScreenCaptureAccess()
    switch method {
    case "ping", "capabilities":
      return [
        "platform": "darwin", "pid": ProcessInfo.processInfo.processIdentifier,
        "bundleId": "dev.zcode.cua-helper", "protocolVersion": protocolVersion,
        "minimumOSVersion": "14.4", "structure": AXIsProcessTrusted(),
        "capture": CGPreflightScreenCaptureAccess(), "input": AXIsProcessTrusted(),
        "backgroundInput": AXIsProcessTrusted() && WindowEventCoordinates.setter != nil, "backgroundInputScope": "conditional-per-operation", "nativeStop": eventTap.map { CGEvent.tapIsEnabled(tap: $0) } ?? false,
        "inputRoutes": ["isolated": "process-targeted", "foreground": "system-events"],
        "nativeFeedback": ["windowIndicators": true, "agentPointer": true],
        "interactiveDesktop": sessionActive,
        "nativePreviewStreams": previewCaptures.count + previewClosing.count,
      ]
    case "presentation": return ["status": "configured"]
    case "preview_visibility": return try await setPreviewVisibility(params)
    case "feedback_state":
      try admit(operation, params)
      var value = feedback.state(operation.key)
      value["taggedGlobalPointerEvents"] = taggedGlobalPointerEvents
      return value
    case "permission_status": return permissionStatus()
    case "request_accessibility":
      let granted = AXIsProcessTrustedWithOptions(
        [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
      return ["ok": granted]
    case "request_screen_recording": return ["ok": CGRequestScreenCaptureAccess()]
    case "list_apps": return listApplications()
    case "resolve_application": return try descriptor(input)
    case "target_status":
      guard params["approved"] as? Bool == true else { throw ControlError("not_authorized", "Registered target probe required") }
      try operation.check()
      return try targetStatus(input, contextKey: operation.key)
    case "launch_app":
      try admit(operation, params, mutation: true)
      restoreSyntheticFocus()
      // 异步启动也属于 GUI 修改；启动期间禁止同回合另一输入操作重入。
      activeOperation = operation
      currentTarget = nil
      currentInputRoute = .isolated
      defer { activeOperation = nil }
      return try await launch(input, operation)
    case "list_windows":
      try admit(operation, params)
      return ["windows": try targets(application(input)).map { $0.json }]
    case "resolve_target":
      try admit(operation, params)
      return try target(input).json
    case "get_state", "preview":
      try admit(operation, params)
      var window: WindowTarget
      if method == "preview" {
        do { window = try previewTarget(input) }
        catch {
          if let id = input["targetId"] as? String, let capture = previewCaptures.removeValue(forKey: "\(operation.key):\(id)") { try await finishPreviewCapture(capture) }
          throw error
        }
      } else { window = try target(input) }
      if method == "get_state", input["text"] as? Bool != false {
        window = try await waitForAccessibilityWindowBinding(window, operation)
      }
      let state = try await observe(window, input, operation, preview: method == "preview")
      if method == "get_state" { try feedback.bind(window, operation, phase: focusBlocked.contains(operation.key) ? .paused : activeOperation?.key == operation.key && currentTarget?.identity == window.identity ? .active : .observing) }
      return state
    case "read_text":
      try admit(operation, params)
      return try readText(target(input), input, operation)
    case "stop":
      feedback.remove(operation.key)
      stopped.insert(operation.key)
      if activeOperation?.key == operation.key, let active = activeOperation {
        cancellations.cancel(active.id)
      }
      if device.owner == operation.key, !cleanupInput() {
        throw ControlError(
          "stop_unconfirmed", "Native input cleanup could not be confirmed", ["outcome": "unknown"])
      }
      device.release(operation.key)
      observations = observations.filter { !$0.key.hasPrefix(operation.key) }
      pruneChangeObservers()
      try await closePreviewCaptures(operation.key)
      return ["status": "stopped"]
    case "resume":
      guard params["approved"] as? Bool == true else {
        throw ControlError("not_authorized", "Trusted user resume required")
      }
      guard sessionActive, cleanupInput() else {
        throw ControlError("stop_unconfirmed", "Native input cleanup could not be confirmed")
      }
      try device.acknowledge(operation.key)
      stopped.remove(operation.key)
      focusBlocked.remove(operation.key)
      observations = observations.filter { !$0.key.hasPrefix(operation.key) }
      pruneChangeObservers()
      return ["status": "ready"]
    case "close_target":
      // 已关闭窗口不能重新 resolve；清理只作用于该 context 下登记的旧 identity。
      let identity = try (input["targetId"] as? String) ?? target(input).identity
      if let capture = previewCaptures.removeValue(forKey: "\(operation.key):\(identity)") { try await finishPreviewCapture(capture) }
      feedback.remove(operation.key, targetId: identity)
      observations.removeValue(forKey: "\(operation.key):\(identity)")
      if !observations.keys.contains(where: { $0.hasPrefix(operation.key) }) {
        if device.owner == operation.key {
          guard cleanupInput() else {
            throw ControlError(
              "stop_unconfirmed", "Native input cleanup could not be confirmed",
              ["outcome": "unknown"])
          }
          currentTarget = nil
        }
        device.release(operation.key)
      }
      pruneChangeObservers()
      return ["status": "closed"]
    case "release":
      feedback.remove(operation.key)
      if device.owner == operation.key, !cleanupInput() {
        throw ControlError(
          "stop_unconfirmed", "Native input cleanup could not be confirmed", ["outcome": "unknown"])
      }
      device.release(operation.key)
      observations = observations.filter { !$0.key.hasPrefix(operation.key) }
      pruneChangeObservers()
      if params["ended"] as? Bool == true {
        stopped.remove(operation.key)
        focusBlocked.remove(operation.key)
      }
      try await closePreviewCaptures(operation.key)
      return ["status": "closed"]
    case "click", "move", "drag", "scroll", "press_key", "type_text", "set_value",
      "secondary_action", "select_text", "activate":
      let route = try inputRoute(input, method: method)
      try admit(operation, params, mutation: true, requireNeutral: route == .foreground)
      let window = try target(input)
      postedSegments = 0
      activeOperation = operation
      currentTarget = window
      currentInputRoute = route
      if route == .foreground { restoreSyntheticFocus() }
      defer { activeOperation = nil }
      defer { if !stopped.contains(operation.key) && !focusBlocked.contains(operation.key) { try? feedback.phase(window, operation, .waiting) } }
      do { try feedback.phase(window, operation, .active); return try await perform(method, input, window, operation) } catch let error
        as ControlError
      {
        let cleaned = cleanupInput()
        var details = error.details
        details["outcome"] =
          cleaned ? (postedSegments > 0 ? "partial-or-unknown" : "rejected") : "unknown"
        details["acceptedSegments"] = postedSegments
        details["cleanupConfirmed"] = cleaned
        if !cleaned { stopCurrentControl(reason: "input-cleanup-unconfirmed") }
        throw ControlError(
          cleaned ? error.code : "stop_unconfirmed", error.message, details)
      } catch {
        let cleaned = cleanupInput()
        if !cleaned { stopCurrentControl(reason: "input-cleanup-unconfirmed") }
        throw ControlError(
          cleaned ? "native_error" : "stop_unconfirmed", error.localizedDescription,
          [
            "outcome": !cleaned || postedSegments == 0 ? "unknown" : "partial-or-unknown",
            "acceptedSegments": postedSegments,
            "cleanupConfirmed": cleaned,
          ])
      }
    default: throw ControlError("unknown_method", "Unknown native computer method")
    }
  }
  func shutdown() async {
    managedEventTap?.close()
    managedEventTap = nil
    feedback.dispose()
    for observer in changeObservers.values {
      CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
    }
    changeObservers.removeAll()
    changeTargets.removeAll()
    if cleanupInput() { device.release() } else { device.abandon() }
    observations.removeAll()
    for observer in observers {
      NotificationCenter.default.removeObserver(observer)
      NSWorkspace.shared.notificationCenter.removeObserver(observer)
      DistributedNotificationCenter.default().removeObserver(observer)
    }
    observers.removeAll()
    if let tap = eventTap {
      CGEvent.tapEnable(tap: tap, enable: false)
      CFMachPortInvalidate(tap)
    }
    eventTap = nil
    if let source = eventSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
    eventSource = nil
    try? await closePreviewCaptures()
  }
}
