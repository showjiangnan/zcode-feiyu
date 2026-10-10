// Modified by ZCode Feiyu contributors (2026).
import Foundation

struct InstalledApplication {
  let url: URL
  let identifier: String
  let name: String
  let bundleName: String
  var descriptor: [String: Any] {
    ["appId": identifier, "appKey": identifier, "displayName": name,
      "path": url.path, "isRunning": false]
  }
  func matches(_ value: String) -> Bool {
    identifier == value || url.path == value
      || name.caseInsensitiveCompare(value) == .orderedSame
      || bundleName.caseInsensitiveCompare(value) == .orderedSame
      || url.deletingPathExtension().lastPathComponent.caseInsensitiveCompare(value) == .orderedSame
  }
}

struct InstalledApplicationCatalog {
  let applications: [InstalledApplication]
  let truncated: Bool
}

func installedApplication(_ url: URL) -> InstalledApplication? {
  guard url.pathExtension.lowercased() == "app", let bundle = Bundle(url: url),
    let identifier = bundle.bundleIdentifier,
    bundle.object(forInfoDictionaryKey: "CFBundlePackageType") as? String == "APPL"
  else { return nil }
  let basename = url.deletingPathExtension().lastPathComponent
  let bundleName = bundle.object(forInfoDictionaryKey: "CFBundleName") as? String ?? basename
  return InstalledApplication(
    url: url.resolvingSymlinksInPath(), identifier: identifier,
    name: bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? bundleName,
    bundleName: bundleName)
}

func installedApplicationCatalog(
  roots: [URL] = [URL(fileURLWithPath: "/Applications"),
    URL(fileURLWithPath: "/System/Applications"),
    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications")],
  limit: Int = 2048, maximumDepth: Int = 3
) -> InstalledApplicationCatalog {
  let manager = FileManager.default
  var pending = roots.map { ($0, 0) }
  var seen = Set<String>()
  var applications: [InstalledApplication] = []
  var scanned = 0
  var truncated = false
  while !pending.isEmpty {
    let (folder, depth) = pending.removeLast()
    guard let children = try? manager.contentsOfDirectory(
      at: folder, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
      options: [.skipsHiddenFiles]) else { continue }
    for url in children.sorted(by: { $0.path < $1.path }) {
      scanned += 1
      if scanned > 8192 || applications.count >= limit {
        truncated = true
        pending.removeAll()
        break
      }
      let facts = try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
      guard facts?.isDirectory == true, facts?.isSymbolicLink != true else { continue }
      // 仅扫描标准应用目录；app 是叶子，不深入 Frameworks/Helpers 或任意用户项目。
      if url.pathExtension.lowercased() == "app" {
        if let app = installedApplication(url), seen.insert(app.url.path).inserted {
          applications.append(app)
        }
      } else if depth < maximumDepth {
        pending.append((url, depth + 1))
      }
    }
  }
  return InstalledApplicationCatalog(applications: applications, truncated: truncated)
}
