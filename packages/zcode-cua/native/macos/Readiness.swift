// Modified by ZCode Feiyu contributors (2026).
import AppKit
import ApplicationServices
import Foundation

extension NativeEngine {
  var changeNotifications: [String] {
    [
      kAXValueChangedNotification, kAXSelectedTextChangedNotification, kAXMovedNotification,
      kAXResizedNotification, kAXUIElementDestroyedNotification, kAXLayoutChangedNotification,
    ]
  }
  func pruneChangeObservers(preserving target: WindowTarget? = nil) {
    var retained = Set(observations.values.map { $0.target.identity })
    if device.owner != nil, let currentTarget { retained.insert(currentTarget.identity) }
    if let target { retained.insert(target.identity) }
    // 订阅随观察引用而非 PID 永久保留，防止长会话反复开关窗口累积远端 AX 引用。
    for (id, window) in changeTargets where !retained.contains(id) {
      if let observer = changeObservers[window.app.processIdentifier], let ax = window.ax {
        for notification in changeNotifications {
          _ = AXObserverRemoveNotification(observer, ax, notification as CFString)
        }
      }
      changeTargets.removeValue(forKey: id)
    }
    let pids = Set(changeTargets.values.map { $0.app.processIdentifier })
    for (pid, observer) in changeObservers where !pids.contains(pid) {
      CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
      changeObservers.removeValue(forKey: pid)
    }
  }
  func watchChanges(_ target: WindowTarget) {
    guard freshAccessibility, let window = target.ax else { return }
    pruneChangeObservers(preserving: target)
    let pid = target.app.processIdentifier
    if changeObservers[pid] == nil {
      var observer: AXObserver?
      if AXObserverCreate(
        pid,
        { _, _, _, context in
          guard let context else { return }
          let engine = Unmanaged<NativeEngine>.fromOpaque(context).takeUnretainedValue()
          engine.changeSequence += 1
          engine.lastChange = DispatchTime.now().uptimeNanoseconds
        }, &observer) == .success, let observer
      {
        changeObservers[pid] = observer
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
      }
    }
    guard let observer = changeObservers[pid] else { return }
    if changeTargets[target.identity] != nil { return }
    changeTargets[target.identity] = target
    let pointer = Unmanaged.passUnretained(self).toOpaque()
    for notification in changeNotifications {
      _ = AXObserverAddNotification(observer, window, notification as CFString, pointer)
    }
  }
  func waitForSettled(_ operation: Operation, since version: Int) async throws -> Bool {
    let started = DispatchTime.now().uptimeNanoseconds
    var previous = changeSequence
    var stableSince = started
    repeat {
      try operation.check()
      let now = DispatchTime.now().uptimeNanoseconds
      if previous != changeSequence {
        previous = changeSequence
        stableSince = now
      }
      // 静默窗口根据 AX 变更事件重新计时；超时仅报告未稳定，不能冒充动作完成。
      if now - stableSince >= 80_000_000 { return true }
      if now - started >= 1_500_000_000 { return false }
      try await Task.sleep(nanoseconds: 10_000_000)
    } while true
  }
}
