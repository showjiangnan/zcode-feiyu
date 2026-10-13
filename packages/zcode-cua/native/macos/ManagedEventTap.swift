// Modified by ZCode Feiyu.
import ApplicationServices
import Foundation

// 系统监听使用独立 run loop；回调不能执行 AX 查询或等待主线程任务。
final class ManagedEventTap: @unchecked Sendable {
  private let lock = NSLock()
  private var port: CFMachPort?
  private var loop: CFRunLoop?
  private var closed = false
  private var thread: Thread?
  private let receive: @Sendable (CGEventType, CGEvent?) -> Void
  init(receive: @escaping @Sendable (CGEventType, CGEvent?) -> Void) { self.receive = receive }
  var tap: CFMachPort? { lock.lock(); defer { lock.unlock() }; return port }
  private var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return closed }
  func start(mask: CGEventMask) {
    let ready = DispatchSemaphore(value: 0)
    let worker = Thread { [self] in
      let pointer = Unmanaged.passUnretained(self).toOpaque()
      let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: { _, type, event, pointer in
        if let pointer {
          let owner = Unmanaged<ManagedEventTap>.fromOpaque(pointer).takeUnretainedValue()
          if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput, let tap = owner.tap { CGEvent.tapEnable(tap: tap, enable: true) }
          if (type != .mouseMoved && type != .leftMouseDragged) || event.getIntegerValueField(.eventSourceUserData) == nativeEventTag { owner.receive(type, event.copy()) }
        }
        return Unmanaged.passUnretained(event)
      }, userInfo: pointer)
      let runLoop = CFRunLoopGetCurrent()!
      lock.lock(); let stopped = closed; if !stopped { port = tap; loop = runLoop }; lock.unlock()
      guard let tap, !stopped else { if let tap { CFMachPortInvalidate(tap) }; ready.signal(); return }
      let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
      CFRunLoopAddSource(runLoop, source, .commonModes)
      CGEvent.tapEnable(tap: tap, enable: true)
      ready.signal()
      while !isClosed { CFRunLoopRunInMode(.defaultMode, 0.25, true) }
      CFRunLoopRemoveSource(runLoop, source, .commonModes)
      CFMachPortInvalidate(tap)
    }
    worker.name = "ZCode input monitoring"
    worker.qualityOfService = .userInteractive
    thread = worker
    worker.start()
    if ready.wait(timeout: .now() + 2) == .timedOut { close() }
  }
  func close() {
    lock.lock(); closed = true; let tap = port, runLoop = loop; port = nil; loop = nil; lock.unlock()
    if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
    if let runLoop { CFRunLoopStop(runLoop) }
    thread = nil
  }
}
