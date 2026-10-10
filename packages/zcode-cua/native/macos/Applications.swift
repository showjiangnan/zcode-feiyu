// Modified by ZCode Feiyu contributors (2026).
import AppKit
import ApplicationServices
import Foundation

struct WindowTarget {
  let app: NSRunningApplication
  let id: CGWindowID
  let frame: CGRect
  let title: String
  let ax: AXUIElement?
  var structureReason: String? = nil
  var incarnation: String {
    accessibilityIncarnation(app)
  }
  var identity: String { "\(incarnation):\(id)" }
  var json: [String: Any] {
    [
      "targetId": identity, "windowId": id, "pid": app.processIdentifier,
      "appId": app.bundleIdentifier ?? app.executableURL?.path ?? "",
      "appKey": app.bundleIdentifier ?? app.executableURL?.path ?? "",
      "displayName": app.localizedName ?? "Application", "title": title, "frame": rectangle(frame),
      "processIncarnation": incarnation, "structureAvailable": ax != nil,
      "structureReason": structureReason ?? "available",
    ]
  }
}
extension NativeEngine {
  func application(_ input: [String: Any]) throws -> NSRunningApplication {
    if let number = input["pid"] {
      let pid = try finite(number, "pid")
      guard pid.rounded() == pid, pid > 0, pid <= Double(Int32.max),
        let app = NSRunningApplication(processIdentifier: pid_t(pid)), !app.isTerminated
      else { throw ControlError("target_unavailable", "Target process is not running") }
      return app
    }
    let name = try requiredString(
      input["appId"] ?? input["app"] ?? input["identifier"], "application")
    let matches = NSWorkspace.shared.runningApplications.filter {
      $0.bundleIdentifier == name || $0.executableURL?.path == name
        || $0.bundleURL?.resolvingSymlinksInPath().path == name
        || $0.localizedName?.caseInsensitiveCompare(name) == .orderedSame
    }
    guard matches.count == 1, let app = matches.first else {
      throw ControlError(
        matches.isEmpty ? "target_unavailable" : "ambiguous_target",
        matches.isEmpty
          ? "Application is not running; launch it first"
          : "Multiple applications match; use the exact appId")
    }
    return app
  }
  func descriptor(_ input: [String: Any]) throws -> [String: Any] {
    do {
      let app = try application(input)
      let path = app.bundleURL?.resolvingSymlinksInPath().path ?? ""
      return [
        "appId": app.bundleIdentifier ?? app.executableURL?.path ?? "",
        "appKey": app.bundleIdentifier ?? app.executableURL?.path ?? "",
        "pid": app.processIdentifier, "displayName": app.localizedName ?? "Application",
        "processIncarnation":
          "\(app.processIdentifier):\(app.launchDate?.timeIntervalSince1970 ?? 0)", "path": path,
        "fileIdentity": fileIdentity(path), "isRunning": true,
      ]
    } catch let error as ControlError {
      // 多进程歧义和非法 PID 不能降级成另一个已安装目标。
      if error.code != "target_unavailable" || input["pid"] != nil { throw error }
    }
    let identifier = try requiredString(input["appId"] ?? input["app"] ?? input["identifier"], "application")
    let matches = installedApplicationCatalog().applications.filter { $0.matches(identifier) }
    if matches.count > 1 {
      throw ControlError("ambiguous_target", "Multiple installed applications match; use the exact bundle path")
    }
    let url = identifier.hasPrefix("/") ? URL(fileURLWithPath: identifier)
      : matches.first?.url ?? NSWorkspace.shared.urlForApplication(withBundleIdentifier: identifier)
    guard let url, let app = installedApplication(url) else {
      throw ControlError("target_unavailable", "Application could not be identified")
    }
    return app.descriptor.merging(["fileIdentity": fileIdentity(app.url.path)]) { _, value in value }
  }
  func fileIdentity(_ path: String) -> String {
    nativeExecutableIdentity(path)
  }
  func listApplications() -> [String: Any] {
    let catalog = installedApplicationCatalog()
    var byPath = Dictionary(uniqueKeysWithValues: catalog.applications.map { ($0.url.path, $0.descriptor) })
    for app in NSWorkspace.shared.runningApplications where !app.isTerminated {
      let path = app.bundleURL?.resolvingSymlinksInPath().path ?? ""
      // 未注册为用户应用的系统/嵌套 helper 不污染发现列表；用户应用的 accessory 仍可保留。
      guard app.activationPolicy == .regular || byPath[path] != nil else { continue }
      byPath[path] = [
        "pid": app.processIdentifier, "appId": app.bundleIdentifier ?? app.executableURL?.path ?? "",
        "appKey": app.bundleIdentifier ?? app.executableURL?.path ?? "",
        "displayName": app.localizedName ?? "Application", "path": path, "isRunning": true,
        "processIncarnation":
          "\(app.processIdentifier):\(app.launchDate?.timeIntervalSince1970 ?? 0)",
      ]
    }
    return ["apps": byPath.values.sorted {
      String(describing: $0["path"] ?? "") < String(describing: $1["path"] ?? "")
    }, "truncated": catalog.truncated]
  }
  func targets(_ app: NSRunningApplication) throws -> [WindowTarget] {
    guard
      let rows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]]
    else { throw ControlError("window_unavailable", "Window inventory is unavailable") }
    let lookup = try applicationAccessibilityWindows(app)
    let axWindows = lookup.windows
    let axFrames = axWindows.map { axFrame($0) }
    let processFrames: [CGRect] = rows.compactMap { row in
      guard (row[kCGWindowOwnerPID as String] as? Int32) == app.processIdentifier,
        (row[kCGWindowLayer as String] as? Int ?? 0) == 0,
        let bounds = row[kCGWindowBounds as String] as? [String: Double]
      else { return nil }
      return CGRect(dictionaryRepresentation: bounds as CFDictionary)
    }
    return rows.compactMap { row in
      guard (row[kCGWindowOwnerPID as String] as? Int32) == app.processIdentifier,
        let id = row[kCGWindowNumber as String] as? UInt32,
        let bounds = row[kCGWindowBounds as String] as? [String: Double],
        let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary), frame.width > 1,
        frame.height > 1,
        (row[kCGWindowLayer as String] as? Int ?? 0) == 0
      else { return nil }
      let title = row[kCGWindowName as String] as? String ?? ""
      let binding = uniqueAccessibilityWindowIndex(
        frame: frame, processWindowFrames: processFrames, accessibilityFrames: axFrames)
      let ax = binding.map { axWindows[$0] }
      guard ax != nil || row[kCGWindowIsOnscreen as String] as? Bool == true else { return nil }
      return WindowTarget(
        app: app, id: id, frame: frame,
        title: ax.map { axString($0, kAXTitleAttribute) }.flatMap { $0.isEmpty ? nil : $0 } ?? title,
        ax: ax, structureReason: lookup.reason ?? (ax == nil ? "ax-window-unmatched-or-ambiguous" : nil))
    }
  }
  func target(_ input: [String: Any]) throws -> WindowTarget {
    let app = try application(input)
    let windows = try targets(app)
    if let number = input["windowId"] {
      let id = try finite(number, "windowId")
      guard id > 0, id <= Double(UInt32.max), id.rounded() == id,
        let target = windows.first(where: { $0.id == UInt32(id) })
      else { throw ControlError("target_unavailable", "Selected window has closed") }
      if let expected = input["targetId"] as? String, expected != target.identity {
        throw ControlError("stale_target", "Process/window identity changed")
      }
      return target
    }
    if let identity = input["targetId"] as? String {
      guard let target = windows.first(where: { $0.identity == identity }) else {
        throw ControlError("stale_target", "Window identity has expired")
      }
      return target
    }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    if let focused = axValue(axApp, kAXFocusedWindowAttribute),
      let target = windows.first(where: { $0.ax.map { CFEqual($0, focused) } == true })
    {
      return target
    }
    guard windows.count == 1, let window = windows.first else {
      throw ControlError("ambiguous_window", "Select an exact windowId from listWindows")
    }
    return window
  }
  func launch(_ input: [String: Any], _ operation: Operation) async throws -> [String: Any] {
    let identifier = try requiredString(
      input["appId"] ?? input["app"] ?? input["identifier"], "application")
    // 启动同一已批准的 bundle，不按名称再选另一个副本；原生授权继续校验文件身份。
    let path = try requiredString(operation.application["path"], "approved application path")
    let url = URL(fileURLWithPath: path)
    // 全应用资格由工作区开启意图授予；原生继续核对准确 bundle、系统权限和设备租约。
    let config = NSWorkspace.OpenConfiguration()
    config.activates = false
    config.addsToRecentItems = false
    let app = try await NSWorkspace.shared.openApplication(at: url, configuration: config)
    repeat {
      try operation.check()
      let windows = try targets(app)
      if !windows.isEmpty {
        return [
          "appId": app.bundleIdentifier ?? identifier, "pid": app.processIdentifier,
          "windows": windows.map { $0.json },
        ]
      }
      try await Task.sleep(nanoseconds: 20_000_000)
    } while true
  }
}
