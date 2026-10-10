// Modified by ZCode Feiyu contributors (2026).
import AppKit
import Foundation

func nativeExecutableIdentity(_ path: String) -> String {
  guard let bundle = Bundle(path: path), let executable = bundle.executablePath,
    let attributes = try? FileManager.default.attributesOfItem(atPath: executable)
  else { return "" }
  return
    "\(attributes[.systemNumber] ?? ""):\(attributes[.systemFileNumber] ?? ""):\(attributes[.size] ?? ""):\(attributes[.modificationDate] ?? ""):\(bundle.object(forInfoDictionaryKey: "CFBundleVersion") ?? "")"
}
func checkNativeAuthorization(_ gate: [String: Any], _ application: [String: Any]) throws {
  if !gate.isEmpty {
    let path = try requiredString(gate["path"], "authorization gate")
    let expected = try requiredString(gate["epoch"], "authorization revision")
    var epoch = "initial"
    do {
      let data = try Data(contentsOf: URL(fileURLWithPath: path), options: .mappedIfSafe)
      guard data.count <= 4096,
        let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
        value["schemaVersion"] as? Int == 1, let revision = value["epoch"] as? String
      else {
        throw ControlError("authorization_unavailable", "Application approval revision is invalid")
      }
      epoch = revision
    } catch let error as NSError
      where error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError
    {
      // 没有发生过撤销的工作区使用初始 epoch；其他 IO 失败不能被当作尚未撤销。
    } catch let error as ControlError { throw error } catch {
      throw ControlError("authorization_unavailable", "Cannot verify application approval revision")
    }
    guard epoch == expected else {
      throw ControlError(
        "permission_revoked", "Application approval was revoked", ["outcome": "partial-or-unknown"])
    }
  }
  if let identity = application["fileIdentity"] as? String, !identity.isEmpty {
    let path = try requiredString(application["path"], "approved application path")
    guard nativeExecutableIdentity(path) == identity else {
      throw ControlError("application_changed", "Approved application executable changed")
    }
  }
  if let value = application["pid"], let expected = application["processIncarnation"] as? String {
    let pid = try finite(value, "approved pid")
    guard pid > 0, pid <= Double(Int32.max), pid.rounded() == pid,
      let app = NSRunningApplication(processIdentifier: pid_t(pid)), !app.isTerminated,
      "\(app.processIdentifier):\(app.launchDate?.timeIntervalSince1970 ?? 0)" == expected
    else { throw ControlError("application_changed", "Approved application process changed") }
  }
}
