// Modified by ZCode Feiyu.
import AppKit
import CoreImage
import ScreenCaptureKit

final class PreviewCapture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private let context = CIContext(options: [.cacheIntermediates: false])
  private var latest: CGImage?
  private var failure: Error?
  private var closed = false
  private var stream: SCStream?
  private var startup: Task<Void, Error>?
  private var frameTime = 0.0
  private let queue = DispatchQueue(label: "dev.zcode.cua.preview", qos: .utility)
  let size: CGSize
  init(size: CGSize) { self.size = size }
  private func bind(_ stream: SCStream) -> Bool {
    lock.lock(); defer { lock.unlock() }; guard !closed else { return false }; self.stream = stream; return true
  }
  private func setStartup(_ value: Task<Void, Error>?) {
    lock.lock(); defer { lock.unlock() }; startup = value
  }
  private func detach() -> (SCStream?, Task<Void, Error>?) {
    lock.lock(); defer { lock.unlock() }; closed = true; latest = nil; let active = stream; stream = nil; return (active, startup)
  }
  var capturedAt: Double { lock.lock(); defer { lock.unlock() }; return frameTime }
  var failed: Bool { state().1 != nil }
  func start(filter: SCContentFilter, configuration: SCStreamConfiguration) async throws {
    guard !state().2 else { throw ControlError("cancelled", "Preview was closed") }
    let work = Task.detached { [self] in
      let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
      try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
      guard bind(stream) else { throw ControlError("cancelled", "Preview was closed") }
      try await stream.startCapture()
    }
    setStartup(work)
    defer { setStartup(nil) }
    try await work.value
    if state().2 { throw ControlError("cancelled", "Preview was closed during startup") }
  }
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    // delegate 已确认该流停止；窗口关闭后再次 stopCapture 会把正常关闭误报为清理失败。
    lock.lock()
    if self.stream === stream { self.stream = nil }
    failure = error
    latest = nil
    lock.unlock()
  }
  func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen,
      let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let status = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: status) == .complete,
      let pixels = CMSampleBufferGetImageBuffer(buffer) else { return }
    let image = CIImage(cvPixelBuffer: pixels)
    guard let rendered = context.createCGImage(image, from: image.extent, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)) else { return }
    lock.lock(); if !closed { latest = rendered; frameTime = Date().timeIntervalSince1970 }; lock.unlock()
  }
  private func state() -> (CGImage?, Error?, Bool) {
    lock.lock(); defer { lock.unlock() }; return (latest, failure, closed)
  }
  func frame(operation: Operation) async throws -> CGImage {
    while true {
      try operation.check()
      let (image, error, closed) = state()
      if closed { throw ControlError("cancelled", "Preview was closed") }
      if error != nil { throw ControlError("capture_failed", "Preview stream failed") }
      if let image { return image }
      // 等待真实首帧，不把固定延时或预录画面当作初始化成功。
      try await Task.sleep(nanoseconds: 10_000_000)
    }
  }
  func close() async throws {
    let (active, startup) = detach()
    if let startup { _ = try? await startup.value }
    do { try await active?.stopCapture() }
    catch { throw ControlError("capture_cleanup_failed", "Preview stream cleanup could not be confirmed") }
  }
}

extension NativeEngine {
  func finishPreviewCapture(_ capture: PreviewCapture) async throws {
    let id = ObjectIdentifier(capture)
    previewClosing[id, default: 0] += 1
    try await capture.close()
    if previewClosing[id] == 1 { previewClosing.removeValue(forKey: id) }
    else { previewClosing[id, default: 1] -= 1 }
  }
  func setPreviewVisibility(_ params: [String: Any]) async throws -> [String: Any] {
    let revision = try finite(params["revision"], "preview revision")
    guard revision >= 0, revision.rounded() == revision,
      let sources = params["sources"] as? [[String: Any]], sources.count <= 4 else { throw ControlError("invalid_request", "Invalid preview visibility") }
    guard revision >= previewVisibilityRevision else { return ["status": "stale"] }
    var keys = Set<String>()
    for source in sources {
      let operation = Operation(id: "presentation", context: record(source["context"]), deadline: UInt64.max, cancellations: cancellations)
      keys.insert("\(operation.key):\(try requiredString(source["targetId"], "preview target"))")
    }
    previewVisibilityRevision = revision
    previewVisibleKeys = keys
    let obsolete = previewCaptures.filter { !keys.contains($0.key) }
    for (key, _) in obsolete { previewCaptures.removeValue(forKey: key) }
    for (_, capture) in obsolete { try await finishPreviewCapture(capture) }
    return ["status": "applied"]
  }
  func closePreviewCaptures(_ key: String? = nil) async throws {
    let obsolete = previewCaptures.filter { key == nil || $0.key.hasPrefix(key! + ":") }
    for (id, _) in obsolete { previewCaptures.removeValue(forKey: id) }
    for (_, capture) in obsolete { try await finishPreviewCapture(capture) }
  }
  func previewImage(_ target: WindowTarget, operation: Operation, filter: SCContentFilter, configuration: SCStreamConfiguration) async throws -> CGImage {
    let key = "\(operation.key):\(target.identity)"
    guard previewVisibleKeys?.contains(key) != false else { throw ControlError("cancelled", "Preview is no longer visible") }
    let size = CGSize(width: configuration.width, height: configuration.height)
    var capture = previewCaptures[key]
    if capture?.size != size || capture?.failed == true {
      if let previous = capture { previewCaptures.removeValue(forKey: key); try await finishPreviewCapture(previous) }
      try operation.check()
      guard previewVisibleKeys?.contains(key) != false else { throw ControlError("cancelled", "Preview is no longer visible") }
      guard previewCaptures.count < 4 else { throw ControlError("capture_limit", "Too many preview streams") }
      let next = PreviewCapture(size: size)
      previewCaptures[key] = next
      capture = next
      configuration.minimumFrameInterval = CMTime(value: 1, timescale: 5)
      configuration.queueDepth = 3
      do { try await Task.detached { try await next.start(filter: filter, configuration: configuration) }.value }
      catch { if previewCaptures[key] === next { previewCaptures.removeValue(forKey: key) }; try await finishPreviewCapture(next); throw error }
    }
    let image = try await capture!.frame(operation: operation)
    guard previewVisibleKeys?.contains(key) != false else { throw ControlError("cancelled", "Preview is no longer visible") }
    return image
  }
}
