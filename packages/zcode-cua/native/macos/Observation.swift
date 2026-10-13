// Modified by ZCode Feiyu.
import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit

struct ObservedNode {
  let element: AXUIElement
  let path: String
  let role: String
  let labelFingerprint: String
  let valueFingerprint: String
  let json: [String: Any]
}
struct Observation {
  let id: String
  let target: WindowTarget
  let nodes: [String: ObservedNode]
  let imageId: String?
  let imageWidth: Int
  let imageHeight: Int
  let changeSequence: Int
  let imageBounds: CGRect
  let fingerprint: String
  let flat: [[String: Any]]
  let scope: String
}
struct AccessibilitySample {
  let nodes: [String: ObservedNode]
  let flat: [[String: Any]]
  let continuations: [[String: Any]]
  let truncated: Bool
}
func sampleAccessibility(_ root: AXUIElement, _ id: String, _ operation: Operation, maximum: Int, rootPath: String = "0", childOffset: Int = 0, previous: Observation? = nil)
  throws -> AccessibilitySample
{
  let oldByPath = Dictionary(uniqueKeysWithValues: (previous?.nodes ?? [:]).values.map { ($0.path, $0) })
  var fingerprints: [String: (label: String, value: String)] = [:]
  let tree = try sampleElementTree(root: root, rootPath: rootPath, childOffset: childOffset, maximum: maximum,
    check: { try operation.check() }, equal: { CFEqual($0, $1) }, describe: { element, path in
    AXUIElementSetMessagingTimeout(element, 0.15)
    let attributes = try observationAttributes(element)
    let role = attributes[kAXRoleAttribute] as! String
    let label =
      [
        attributes[kAXTitleAttribute] as? String ?? "", attributes[kAXDescriptionAttribute] as? String ?? "",
        attributes[kAXHelpAttribute] as? String ?? "",
      ].first { !$0.isEmpty } ?? ""
    let secure = attributes[kAXSubroleAttribute] as? String == kAXSecureTextFieldSubrole
    let value = secure ? "[protected]" : try checkedAccessibilityText(element, kAXValueAttribute, optional: true)
    let labelFingerprint = textFingerprint(label), valueFingerprint = textFingerprint(value)
    fingerprints[path] = (labelFingerprint, valueFingerprint)
    // 只有同路径、同原生对象才保留引用；复用路径的新控件必须获得新 ID。
    let oldNode = oldByPath[path]
    let key = oldNode.map { CFEqual($0.element, element) && $0.role == role ? $0.json["elementId"] as? String : nil } ?? nil
    let elementId = key ?? "\(id):\(path)"
    var names: CFArray?
    AXUIElementCopyActionNames(element, &names)
    var json: [String: Any] = [
      "elementId": elementId, "path": path, "role": role, "label": textSlice(label, offset: 0, length: 2048).text,
      "value": textSlice(value, offset: 0, length: 4096).text, "secure": secure,
      "labelTruncated": label.utf16.count > 2048, "valueTruncated": !secure && value.utf16.count > 4096,
      "valueLength": secure ? 0 : value.utf16.count, "textUnit": "utf16",
      "textRevision": oldNode?.labelFingerprint == labelFingerprint && oldNode?.valueFingerprint == valueFingerprint ? oldNode?.json["textRevision"] as? String ?? UUID().uuidString : UUID().uuidString,
      "enabled": (attributes[kAXEnabledAttribute] as? Bool) ?? true,
      "focused": (attributes[kAXFocusedAttribute] as? Bool) ?? false,
      "actions": names as? [String] ?? [],
    ]
    if let frame = axFrame(element) { json["frame"] = rectangle(frame) }
    return json
  }, children: { element, offset, remaining in
    var count: CFIndex = 0
    guard AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count) == .success, count > 0 else { return (0, []) }
    guard offset < count else { throw ControlError("stale_element", "Continuation children changed") }
    let amount = min(count - offset, remaining)
    if amount == 0 { return (count, []) }
    var values: CFArray?
    guard AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, offset, amount, &values) == .success,
      let children = values as? [AXUIElement] else { throw ControlError("accessibility-busy", "Children could not be sampled consistently") }
    return (count, children)
  })
  let nodes = Dictionary(uniqueKeysWithValues: tree.records.map { record in
    let row = record.row
    return (row["elementId"] as! String, ObservedNode(element: record.element, path: record.path,
      role: row["role"] as! String, labelFingerprint: fingerprints[record.path]!.label, valueFingerprint: fingerprints[record.path]!.value, json: row))
  })
  return AccessibilitySample(nodes: nodes, flat: tree.records.map { $0.row }, continuations: tree.continuations, truncated: !tree.continuations.isEmpty)
}
extension NativeEngine {
  func observe(
    _ window: WindowTarget, _ input: [String: Any], _ operation: Operation, preview: Bool
  ) async throws -> [String: Any] {
    try operation.check()
    watchChanges(window)
    let sampleSequence = changeSequence
    let id = UUID().uuidString
    let key = "\(operation.key):\(window.identity)"
    let previous = observations[key]
    let imageRequested = preview || (input["image"] as? Bool ?? true)
    let textRequested = !preview && (input["text"] as? Bool ?? true)
    let started = Date().timeIntervalSince1970
    var body = window.json
    // 预览只是图片投影；能力由 Agent 的正式观察读取，不能每帧重复查询焦点树。
    if !preview { body["inputCapabilities"] = inputCapabilities(window) }
    var channels: [String: Any] = [:]
    var sample: AccessibilitySample?
    var rootPath = "0"
    let rawOffset = try finite(input["childOffset"], "childOffset", default: 0)
    guard rawOffset >= 0, rawOffset <= 100000, rawOffset.rounded() == rawOffset else { throw ControlError("invalid_request", "Invalid childOffset") }
    let childOffset = Int(rawOffset)
    let targeted = input["elementId"] != nil || input["childOffset"] != nil
    var scope = "0:0"
    if textRequested {
      if freshAccessibility, AXIsProcessTrusted(), let ax = window.ax {
        let contentReady = try await waitForAccessibilityContent(window, operation)
        let maximum = try finite(input["maxNodes"], "maxNodes", default: 1000)
        guard maximum >= 1, maximum <= 5000, maximum.rounded() == maximum else {
          throw ControlError("invalid_request", "maxNodes must be 1–5000")
        }
        var root = ax
        if let elementId = input["elementId"] as? String {
          guard let node = previous?.nodes[elementId],
            axString(node.element, kAXRoleAttribute) == node.role
          else {
            throw ControlError("stale_element", "Targeted element has expired; read a fresh state")
          }
          root = node.element
          rootPath = node.path
        }
        if input["childOffset"] != nil {
          var count: CFIndex = 0
          guard childOffset >= 0,
            AXUIElementGetAttributeValueCount(root, kAXChildrenAttribute as CFString, &count) == .success,
            childOffset < count else { throw ControlError("stale_element", "Continuation children changed") }
        }
        scope = "\(rootPath):\(childOffset)"
        do {
          sample = try await Task.detached(priority: .userInitiated) {
            try sampleAccessibility(root, id, operation, maximum: Int(maximum), rootPath: rootPath, childOffset: childOffset, previous: previous)
          }.value
        } catch let error as ControlError where ["accessibility_busy", "accessibility-busy", "structure_unavailable", "text_limit", "text_unsupported"].contains(error.code) {
          // AX 临时繁忙不得伪造空控件，也不能丢掉仍然合法的窗口截图。
          channels["text"] = ["status": error.code.hasPrefix("accessibility") ? "busy" : "unsupported", "reason": error.code]
          body["structureReason"] = error.code
        }
        var textChannel: [String: Any] = ["status": contentReady ? "available" : "busy",
          "sampledAt": Date().timeIntervalSince1970]
        if !contentReady { textChannel["reason"] = "accessibility-initializing" }
        if channels["text"] == nil { channels["text"] = textChannel }
        // 初始窗口描述采样早于内容就绪；不能把成功观察继续标成 initializing。
        if contentReady && sample != nil { body["structureReason"] = "available" }
      } else {
        channels["text"] = [
          "status": ["accessibility-busy", "accessibility-initializing"].contains(window.structureReason ?? "") ? "busy"
            : AXIsProcessTrusted() && freshAccessibility ? "unsupported" : "permission-denied",
          "reason": window.structureReason ?? "Accessibility structure is unavailable for this exact window",
        ]
      }
    }
    var imageData: String?
    var width = 0
    var height = 0
    var imageId: String?
    if imageRequested {
      if freshScreenCapture, CGPreflightScreenCaptureAccess() {
        guard sessionActive else { throw ControlError("locked", "Desktop is locked") }
        if preview && window.app.bundleIdentifier?.hasPrefix("dev.zcode.app") == true {
          channels["image"] = [
            "status": "preview-paused", "reason": "Target contains the preview itself",
          ]
        } else {
          do {
            let screenshot = try await capture(
              window, operation, preview: preview, region: record(input["region"]))
            imageData = screenshot.0
            width = screenshot.1
            height = screenshot.2
            imageId = UUID().uuidString
            channels["image"] = ["status": "available", "sampledAt": Date().timeIntervalSince1970]
          } catch let error as ControlError {
            if ["locked", "cancelled", "deadline", "capture_revoked"].contains(error.code) {
              throw error
            }
            channels["image"] = ["status": "unavailable", "reason": error.code]
          } catch {
            channels["image"] = [
              "status": "unavailable", "reason": "capture_failed",
              "message": error.localizedDescription,
            ]
          }
        }
      } else {
        if preview { try await closePreviewCaptures(operation.key) }
        channels["image"] = [
          "status": "permission-denied", "reason": "Screen Recording permission is required",
        ]
      }
    }
    try operation.check()
    guard sessionActive, !stopped.contains(operation.key),
      let current = preview ? try previewTarget(window.json) : try targets(window.app).first(where: { $0.id == window.id }),
      current.identity == window.identity, current.frame.equalTo(window.frame)
    else {
      throw ControlError(
        "inconsistent_observation",
        "Window or control qualification changed during capture; observe again")
    }
    body["observationId"] = id
    body["revision"] = id
    body["capturedAt"] = Date().timeIntervalSince1970
    if preview && imageData != nil, let capture = previewCaptures[key] { body["capturedAt"] = capture.capturedAt }
    body["sampleStartedAt"] = started
    body["consistency"] = "bounded-sampling"
    body["channels"] = channels
    if let sample {
      body["nodes"] = sample.flat
      if targeted { body["scope"] = ["rootPath": rootPath, "childOffset": childOffset] }
      body["truncated"] = sample.truncated
      body["continuation"] = sample.continuations
      if input["disableDiff"] as? Bool != true, input["diff"] as? Bool == true, let previous,
        input["baselineRevision"] as? String == previous.id, previous.scope == scope, !previous.flat.isEmpty
      {
        let old = Dictionary(
          uniqueKeysWithValues: previous.flat.compactMap { row -> (String, String)? in
            guard let path = row["path"] as? String else { return nil }
            let stable = row

            return (
              path,
              String(
                data: (try? JSONSerialization.data(withJSONObject: stable, options: .sortedKeys))
                  ?? Data(), encoding: .utf8) ?? ""
            )
          })
        let changes = sample.flat.filter { row in
          let stable = row

          let encoded =
            String(
              data: (try? JSONSerialization.data(withJSONObject: stable, options: .sortedKeys))
                ?? Data(), encoding: .utf8) ?? ""
          return old[row["path"] as? String ?? ""] != encoded
        }
        body["diff"] = [
          "baseRevision": previous.id, "nextRevision": id, "changed": changes,
          "removed": old.keys.filter { path in
            !sample.flat.contains { $0["path"] as? String == path }
          },
        ]
        body["fullReset"] = false
        body["compact"] = input["compact"] as? Bool == true
      } else {
        body["fullReset"] = true
      }
    }
    if let imageData, let imageId {
      body["imageBounds"] = rectangle(imageRegion(window, record(input["region"])))
      body["image"] = [
        "data": imageData, "mimeType": preview ? "image/jpeg" : "image/png", "width": width,
        "height": height, "imageId": imageId, "coordinateSpace": "image-pixels",
        "colorSpace": "sRGB-SDR",
      ]
    }
    if !preview {
      if observations[key] == nil, observations.count >= 128 {
        throw ControlError(
          "observation_limit", "Close unused targets before opening more observations")
      }
      let fingerprint =
        sample?.flat.map {
          "\($0["path"] ?? ""):\($0["role"] ?? ""):\($0["label"] ?? ""):\($0["value"] ?? "")"
        }.joined(separator: "\n") ?? ""
      observations[key] = Observation(
        id: id, target: window, nodes: sample?.nodes ?? [:], imageId: imageId, imageWidth: width,
        imageHeight: height, changeSequence: sampleSequence,
        imageBounds: imageRegion(window, record(input["region"])), fingerprint: fingerprint,
        flat: sample?.flat ?? [], scope: scope)
    }
    return body
  }
  func imageRegion(_ target: WindowTarget, _ region: [String: Any]) -> CGRect {
    if region.isEmpty {
      return CGRect(x: 0, y: 0, width: target.frame.width, height: target.frame.height)
    }
    return CGRect(
      x: region["x"] as? Double ?? -1, y: region["y"] as? Double ?? -1,
      width: region["width"] as? Double ?? -1, height: region["height"] as? Double ?? -1)
  }
  func capture(_ target: WindowTarget, _ operation: Operation, preview: Bool, region: [String: Any])
    async throws -> (String, Int, Int)
  {
    try operation.check()
    let content = try await currentShareableContent()
    guard
      let window = content.windows.first(where: {
        $0.windowID == target.id && $0.owningApplication?.processID == target.app.processIdentifier
      })
    else { throw ControlError("capture_unavailable", "Approved window cannot be captured") }
    let config = SCStreamConfiguration()
    config.colorSpaceName = CGColorSpace.sRGB
    let maxDimension = preview ? 1280.0 : 2000.0
    let scale = min(preview ? 1.0 : 2.0, maxDimension / max(window.frame.width, window.frame.height))
    config.width = max(1, Int(window.frame.width * scale))
    config.height = max(1, Int(window.frame.height * scale))
    // 原图只包含目标内容；系统光标会污染背景图，未缩放内容则使 Retina 像素坐标失真。
    config.showsCursor = false
    config.scalesToFit = true
    config.ignoreShadowsSingleWindow = true
    // 单目标截图不得默认合成窗口家族，否则浮动窗图像与输入坐标会失配。
    config.includeChildWindows = false
    let filter = SCContentFilter(desktopIndependentWindow: window)
    // SCS 内部初始化 SCStream/CoreAudio 可能同步阻塞；不能占住停止监控的主线程。
    // 后台完成后仍校验同一 operation，迟到画面不能恢复已取消资格。
    let image: CGImage
    if preview { image = try await previewImage(target, operation: operation, filter: filter, configuration: config) }
    else { image = try await Task.detached(priority: .userInitiated) {
        try operation.check()
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
      }.value }
    try operation.check()
    guard CGPreflightScreenCaptureAccess(), sessionActive else {
      throw ControlError("capture_revoked", "Screen capture permission or desktop state changed")
    }
    let logical = imageRegion(target, region)
    guard logical.width > 0, logical.height > 0,
      CGRect(x: 0, y: 0, width: target.frame.width, height: target.frame.height).contains(logical)
    else { throw ControlError("out_of_bounds", "Capture region is outside the approved window") }
    let crop = CGRect(
      x: logical.minX * Double(image.width) / target.frame.width,
      y: logical.minY * Double(image.height) / target.frame.height,
      width: logical.width * Double(image.width) / target.frame.width,
      height: logical.height * Double(image.height) / target.frame.height
    ).integral
    guard let cropped = image.cropping(to: crop) else {
      throw ControlError("capture_unavailable", "Capture region is unavailable")
    }
    return try await Task.detached(priority: .userInitiated) {
      var raster = cropped
      repeat {
        try operation.check()
        let rep = NSBitmapImageRep(cgImage: raster)
        if let data = rep.representation(
          using: preview ? .jpeg : .png, properties: preview ? [.compressionFactor: 0.65] : [:]),
          data.count <= (preview ? 1_500_000 : 3_500_000)
        {
          return (data.base64EncodedString(), raster.width, raster.height)
        }
        guard raster.width > 128, raster.height > 128,
          let context = CGContext(
            data: nil, width: Int(Double(raster.width) * 0.75),
            height: Int(Double(raster.height) * 0.75), bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else {
          throw ControlError("image_too_large", "Captured image exceeds the model media limit")
        }
        context.interpolationQuality = .high
        context.draw(raster, in: CGRect(x: 0, y: 0, width: context.width, height: context.height))
        guard let smaller = context.makeImage() else {
          throw ControlError("capture_unavailable", "Image encoding failed")
        }
        raster = smaller
      } while true
    }.value

  }
  func currentShareableContent() async throws -> SCShareableContent {
    if let task = shareableContentTask { return try await task.value }
    // 同一批多画面共享一次在途系统清单；不缓存已完成清单，不用 TTL 隐藏窗口变化。
    let task = Task {
      try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    }
    shareableContentTask = task
    defer { shareableContentTask = nil }
    return try await task.value
  }
}
