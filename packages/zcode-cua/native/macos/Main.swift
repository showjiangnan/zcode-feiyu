// Modified by ZCode Feiyu contributors (2026).
import AppKit
import ApplicationServices
import Foundation

@main struct ComputerControlMain {
  static func main() {
    if CommandLine.arguments.contains("--preflight") {
      let engine = NativeEngine(CancellationRegistry())
      let data = try! JSONSerialization.data(withJSONObject: engine.permissionStatus())
      FileHandle.standardOutput.write(data)
      return
    }
    if CommandLine.arguments.contains("--request-accessibility") {
      _ = AXIsProcessTrustedWithOptions(
        [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
      return
    }
    if CommandLine.arguments.contains("--request-screen-recording") {
      _ = CGRequestScreenCaptureAccess()
      return
    }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let cancellations = CancellationRegistry()
    let outputLock = NSLock()
    let engine = NativeEngine(cancellations)
    let write: @Sendable (String, [String: Any]) -> Void = { id, body in
      var response = body
      response["id"] = id
      response["protocol"] = protocolVersion
      guard let data = try? JSONSerialization.data(withJSONObject: response),
        data.count <= 33_554_432
      else { return }
      outputLock.lock()
      defer { outputLock.unlock() }
      FileHandle.standardOutput.write(data)
      FileHandle.standardOutput.write(Data([10]))
    }
    engine.onControlEvent = { event in write("native-event", ["event": event]) }
    DispatchQueue.global(qos: .userInitiated).async {
      var buffer = Data()
      while true {
        let data = FileHandle.standardInput.availableData
        if data.isEmpty {
          Task { @MainActor in
            engine.shutdown()
            app.terminate(nil)
          }
          return
        }
        buffer.append(data)
        if buffer.count > 1_048_576 {
          Task { @MainActor in
            engine.shutdown()
            app.terminate(nil)
          }
          return
        }
        while let newline = buffer.firstIndex(of: 10) {
          let line = buffer.prefix(upTo: newline)
          buffer.removeSubrange(...newline)
          guard let body = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
            body["protocol"] as? String == protocolVersion, let id = body["id"] as? String,
            let method = body["method"] as? String
          else { continue }
          let params = record(body["params"])
          if method == "cancel" {
            if let original = params["requestId"] as? String { cancellations.cancel(original) }
            write(id, ["ok": true, "result": ["status": "cancelled"]])
            continue
          }
          Task { @MainActor in
            do {
              let result = try await engine.handle(method, params, id: id)
              write(id, ["ok": true, "result": result])
            } catch let error as ControlError {
              write(
                id,
                [
                  "ok": false,
                  "error": [
                    "code": error.code, "message": error.message, "details": error.details,
                  ],
                ])
            } catch {
              write(
                id,
                [
                  "ok": false,
                  "error": ["code": "native_error", "message": error.localizedDescription],
                ])
            }
          }
        }
      }
    }
    app.run()
  }
}
