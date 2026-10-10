// Modified by ZCode Feiyu contributors (2026).
import AppKit
import ApplicationServices
import Darwin
import Foundation

let protocolVersion = "zcode-cua/1"
let nativeEventTag: Int64 = 0x5A_434F_4445
struct ControlError: Error {
  let code: String
  let message: String
  let details: [String: Any]
  init(_ code: String, _ message: String, _ details: [String: Any] = [:]) {
    self.code = code
    self.message = message
    self.details = details
  }
}
final class CancellationRegistry: @unchecked Sendable {
  private let lock = NSLock()
  private var cancelled = Set<String>()
  func cancel(_ id: String) {
    lock.lock()
    if cancelled.count < 512 { cancelled.insert(id) }
    lock.unlock()
  }
  func contains(_ id: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return cancelled.contains(id)
  }
  func remove(_ id: String) {
    lock.lock()
    cancelled.remove(id)
    lock.unlock()
  }
}
struct Operation {
  let id: String
  let context: [String: Any]
  let deadline: UInt64
  let cancellations: CancellationRegistry
  var authorizationGate: [String: Any] = [:]
  var application: [String: Any] = [:]
  var key: String {
    String(
      data: (try? JSONSerialization.data(withJSONObject: [
        context["workspaceKey"] as? String ?? "", context["sessionId"] as? String ?? "",
        context["turnId"] as? String ?? "",
      ])) ?? Data(), encoding: .utf8) ?? "invalid"
  }
  func check() throws {
    try checkNativeAuthorization(authorizationGate, application)
    if cancellations.contains(id) {
      throw ControlError("cancelled", "Computer operation was cancelled")
    }
    if DispatchTime.now().uptimeNanoseconds >= deadline {
      throw ControlError("deadline", "Computer operation deadline exceeded")
    }
  }
}
func record(_ value: Any?) -> [String: Any] { value as? [String: Any] ?? [:] }
func requiredString(_ value: Any?, _ name: String) throws -> String {
  guard let text = value as? String, !text.isEmpty, text.utf8.count <= 4096 else {
    throw ControlError("invalid_request", "Invalid \(name)")
  }
  return text
}
func inputText(_ value: Any?, _ name: String) throws -> String {
  guard let text = value as? String, text.utf16.count <= 100_000 else {
    throw ControlError("invalid_request", "Invalid \(name)")
  }
  return text
}
func finite(_ value: Any?, _ name: String, default fallback: Double? = nil) throws -> Double {
  if value == nil, let fallback { return fallback }
  guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
    number.doubleValue.isFinite
  else { throw ControlError("invalid_request", "\(name) must be finite") }
  return number.doubleValue
}
func rectangle(_ rect: CGRect) -> [String: Double] {
  ["x": rect.origin.x, "y": rect.origin.y, "width": rect.width, "height": rect.height]
}
func axValue(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
    return nil
  }
  return value
}
func axString(_ element: AXUIElement, _ attribute: String) -> String {
  let value = axValue(element, attribute)
  if let text = value as? String { return text }
  if let number = value as? NSNumber { return number.stringValue }
  return ""
}
func axFrame(_ element: AXUIElement) -> CGRect? {
  guard let p = axValue(element, kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID(),
    let s = axValue(element, kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID()
  else { return nil }
  var point = CGPoint.zero
  var size = CGSize.zero
  guard AXValueGetValue(unsafeBitCast(p, to: AXValue.self), .cgPoint, &point),
    AXValueGetValue(unsafeBitCast(s, to: AXValue.self), .cgSize, &size)
  else { return nil }
  return CGRect(origin: point, size: size)
}
final class DeviceLease {
  private var descriptor: Int32 = -1
  private(set) var owner: String?
  func acquire(_ key: String, requireNeutral: Bool = true) throws {
    if owner == key { return }
    if owner != nil {
      throw ControlError("device_busy", "Another task owns the device input lease")
    }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "zcode-cua-\(getuid())", isDirectory: true)
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    var info = stat()
    guard lstat(directory.path, &info) == 0, info.st_uid == getuid(),
      (info.st_mode & S_IFMT) == S_IFDIR
    else { throw ControlError("invalid_owner", "Device lease directory ownership is invalid") }
    let path = directory.appendingPathComponent("device-input.lock").path
    descriptor = open(path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard descriptor >= 0, fstat(descriptor, &info) == 0, info.st_uid == getuid(),
      (info.st_mode & S_IFMT) == S_IFREG
    else {
      release()
      throw ControlError("invalid_owner", "Device lease file is invalid")
    }
    guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
      release()
      throw ControlError("device_busy", "Another local Host owns device input")
    }
    guard fstat(descriptor, &info) == 0, info.st_size == 0 else {
      release()
      throw ControlError(
        "device_quarantined",
        "Previous input cleanup was not confirmed; release all keys and continue from the trusted UI"
      )
    }
    guard !requireNeutral || nativeInputNeutral() else {
      release()
      throw ControlError(
        "foreground_required", "Release all keys and mouse buttons before controlling the computer")
    }
    let marker = Array("zcode-cua-input-dirty-v1".utf8)
    let written = marker.withUnsafeBytes { pwrite(descriptor, $0.baseAddress, $0.count, 0) }
    guard written == marker.count, fsync(descriptor) == 0 else {
      release()
      throw ControlError("device_quarantined", "Device recovery state could not be persisted")
    }
    owner = key
  }
  func acknowledge(_ key: String) throws {
    guard
      nativeInputNeutral()
    else {
      throw ControlError(
        "input_not_neutral", "Release all keys and mouse buttons before continuing")
    }
    if let owner {
      guard owner == key else {
        throw ControlError("device_busy", "Another task owns device input")
      }
      return
    }
    // 取得同一锁后再清理遗留标记；存活的控制 owner 不能被恢复操作越过。
    do { try acquire(key) } catch let error as ControlError where error.code == "device_quarantined"
    {
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
        "zcode-cua-\(getuid())")
      let fd = open(
        directory.appendingPathComponent("device-input.lock").path, O_RDWR | O_NOFOLLOW | O_CLOEXEC)
      guard fd >= 0 else { throw error }
      defer { close(fd) }
      guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
        throw ControlError("device_busy", "Another local Host owns device input")
      }
      defer { flock(fd, LOCK_UN) }
      guard ftruncate(fd, 0) == 0, fsync(fd) == 0 else { throw error }
      return
    }
    release(key)
  }
  func release(_ key: String? = nil) {
    if let key, owner != key { return }
    if descriptor >= 0 {
      if owner != nil {
        // 只有调用方已经确认清理时才清标记；非确认退出走 abandon。
        if ftruncate(descriptor, 0) == 0 { _ = fsync(descriptor) }
      }
      flock(descriptor, LOCK_UN)
      close(descriptor)
    }
    descriptor = -1
    owner = nil
  }
  func abandon() {
    if descriptor >= 0 { close(descriptor) }
    descriptor = -1
    owner = nil
  }
  deinit { abandon() }
}
