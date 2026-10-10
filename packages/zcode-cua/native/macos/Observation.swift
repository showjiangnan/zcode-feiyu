// Modified by ZCode Feiyu contributors (2026).
import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit

struct ObservedNode {
  let element: AXUIElement
  let path: String
  let role: String
  let label: String
  let value: String
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
}
struct AccessibilitySample {
  let nodes: [String: ObservedNode]
  let flat: [[String: Any]]
  let continuations: [[String: Any]]
  let truncated: Bool
}
func sampleAccessibility(_ root: AXUIElement, _ id: String, _ operation: Operation, maximum: Int)
  throws -> AccessibilitySample
{
  var nodes: [String: ObservedNode] = [:]
  var flat: [[String: Any]] = []
  var visited: [AXUIElement] = []
  var continuation: [[String: Any]] = []
  var stack: [(AXUIElement, String, Int)] = [(root, "0", 0)]
  while let (element, path, depth) = stack.popLast() {
    try operation.check()
    if flat.count >= maximum {
      continuation.append(["rootPath": path, "offset": 0])
      break
    }
    if visited.contains(where: { CFEqual($0, element) }) { continue }
    visited.append(element)
    AXUIElementSetMessagingTimeout(element, 0.15)
    let role = axString(element, kAXRoleAttribute)
    let label =
      [
        axString(element, kAXTitleAttribute), axString(element, kAXDescriptionAttribute),
        axString(element, kAXHelpAttribute),
      ].first { !$0.isEmpty } ?? ""
    let secure = axString(element, kAXSubroleAttribute) == kAXSecureTextFieldSubrole
    let value = secure ? "[protected]" : axString(element, kAXValueAttribute)
    let key = "\(id):\(path)"
    var names: CFArray?
    AXUIElementCopyActionNames(element, &names)
    var json: [String: Any] = [
      "elementId": key, "path": path, "role": role, "label": String(label.prefix(2048)),
      "value": String(value.prefix(4096)), "secure": secure,
      "enabled": (axValue(element, kAXEnabledAttribute) as? Bool) ?? true,
      "focused": (axValue(element, kAXFocusedAttribute) as? Bool) ?? false,
      "actions": names as? [String] ?? [],
    ]
    if let frame = axFrame(element) { json["frame"] = rectangle(frame) }
    nodes[key] = ObservedNode(
      element: element, path: path, role: role, label: label, value: value, json: json)
    flat.append(json)
    var count: CFIndex = 0
    guard
      AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count)
        == .success, count > 0
    else { continue }
    let remaining = max(0, maximum - flat.count - stack.count)
    let amount = min(count, remaining)
    if depth >= 128 || amount == 0 {
      continuation.append(["elementId": key, "offset": 0])
      continue
    }
    var values: CFArray?
    if AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, amount, &values)
      == .success, let children = values as? [AXUIElement]
    {
      if count > amount { continuation.append(["elementId": key, "offset": amount]) }
      for (index, child) in children.enumerated().reversed() {
        stack.append((child, "\(path).\(index)", depth + 1))
      }
    }

  }
  return AccessibilitySample(
    nodes: nodes, flat: flat, continuations: continuation, truncated: !continuation.isEmpty)
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
    var channels: [String: Any] = [:]
    var sample: AccessibilitySample?
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
        }
        if let offsetValue = input["childOffset"] {
          let offset = try finite(offsetValue, "childOffset")
          guard offset >= 0, offset.rounded() == offset else {
            throw ControlError("invalid_request", "Invalid childOffset")
          }
          var children: CFArray?
          var count: CFIndex = 0
          guard
            AXUIElementGetAttributeValueCount(root, kAXChildrenAttribute as CFString, &count)
              == .success, offset < Double(count),
            AXUIElementCopyAttributeValues(
              root, kAXChildrenAttribute as CFString, Int(offset), 1, &children) == .success,
            let child = (children as? [AXUIElement])?.first
          else { throw ControlError("stale_element", "Continuation children changed") }
          root = child
        }
        sample = try await Task.detached(priority: .userInitiated) {
          try sampleAccessibility(root, id, operation, maximum: Int(maximum))
        }.value
        var textChannel: [String: Any] = ["status": contentReady ? "available" : "busy",
          "sampledAt": Date().timeIntervalSince1970]
        if !contentReady { textChannel["reason"] = "accessibility-initializing" }
        channels["text"] = textChannel
        // 初始窗口描述采样早于内容就绪；不能把成功观察继续标成 initializing。
        if contentReady { body["structureReason"] = "available" }
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
        channels["image"] = [
          "status": "permission-denied", "reason": "Screen Recording permission is required",
        ]
      }
    }
    try operation.check()
    guard sessionActive, !stopped.contains(operation.key),
      let current = try targets(window.app).first(where: { $0.id == window.id }),
      current.identity == window.identity, current.frame.equalTo(window.frame)
    else {
      throw ControlError(
        "inconsistent_observation",
        "Window or control qualification changed during capture; observe again")
    }
    body["observationId"] = id
    body["revision"] = id
    body["capturedAt"] = Date().timeIntervalSince1970
    body["sampleStartedAt"] = started
    body["consistency"] = "bounded-sampling"
    body["channels"] = channels
    if let sample {
      body["nodes"] = sample.flat
      body["truncated"] = sample.truncated
      body["continuation"] = sample.continuations
      if input["disableDiff"] as? Bool != true, input["diff"] as? Bool == true, let previous,
        input["baselineRevision"] as? String == previous.id
      {
        let old = Dictionary(
          uniqueKeysWithValues: previous.flat.compactMap { row -> (String, String)? in
            guard let path = row["path"] as? String else { return nil }
            var stable = row
            stable.removeValue(forKey: "elementId")
            return (
              path,
              String(
                data: (try? JSONSerialization.data(withJSONObject: stable, options: .sortedKeys))
                  ?? Data(), encoding: .utf8) ?? ""
            )
          })
        let changes = sample.flat.filter { row in
          var stable = row
          stable.removeValue(forKey: "elementId")
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
        flat: sample?.flat ?? [])
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
    let scale = min(2.0, maxDimension / max(window.frame.width, window.frame.height))
    config.width = max(1, Int(window.frame.width * scale))
    config.height = max(1, Int(window.frame.height * scale))
    // 原图只包含目标内容；系统光标会污染背景图，未缩放内容则使 Retina 像素坐标失真。
    config.showsCursor = false
    config.scalesToFit = true
    config.ignoreShadowsSingleWindow = true
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let image = try await SCScreenshotManager.captureImage(
      contentFilter: filter, configuration: config)
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
