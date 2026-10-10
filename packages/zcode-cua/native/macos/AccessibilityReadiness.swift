// Modified by ZCode Feiyu contributors (2026).
import Foundation

@MainActor
func waitForAccessibilityReadiness<Value>(
  until: UInt64, revision: () -> Int, qualify: () throws -> Void,
  probe: () async throws -> Value?
) async throws -> Value? {
  var lastProbe: UInt64 = 0
  var version = revision()
  repeat {
    try qualify()
    let now = DispatchTime.now().uptimeNanoseconds
    if lastProbe == 0 || revision() != version || now - lastProbe >= 100_000_000 {
      let value = try await probe()
      try qualify()
      if let value { return value }
      lastProbe = DispatchTime.now().uptimeNanoseconds
      version = revision()
    }
    // 超时只返回未就绪；事件不受支持时查询真实证据，不能把等待时长当成功依据。
    if DispatchTime.now().uptimeNanoseconds >= until { return nil }
    try await Task.sleep(nanoseconds: 10_000_000)
  } while true
}
