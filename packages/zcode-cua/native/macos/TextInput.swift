// Modified by ZCode Feiyu contributors (2026).
import AppKit
import ApplicationServices
import Foundation

extension NativeEngine {
  func unicodeText(_ text: String, _ operation: Operation) async throws {
    for character in text {
      try operation.check()
      let units = Array(String(character).utf16)
      guard units.count <= 256 else {
        throw ControlError("text_unavailable", "A grapheme exceeds native input capacity")
      }
      let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
      down?.flags = []
      units.withUnsafeBufferPointer {
        down?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: $0.baseAddress!)
      }
      try post(down, operation)
      let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
      up?.flags = []
      units.withUnsafeBufferPointer {
        up?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: $0.baseAddress!)
      }
      try post(up, operation)
      await Task.yield()
    }
  }
  func pasteText(_ text: String, _ operation: Operation) async throws {
    let board = NSPasteboard.general
    let before = board.changeCount
    var bytes = 0
    var formats = 0
    var saved: [NSPasteboardItem] = []
    for item in board.pasteboardItems ?? [] {
      guard saved.count < 128 else {
        throw ControlError(
          "clipboard_unavailable", "Clipboard has too many items to preserve safely")
      }
      let copy = NSPasteboardItem()
      for type in item.types {
        formats += 1
        guard formats <= 256 else {
          throw ControlError(
            "clipboard_unavailable", "Clipboard has too many formats to preserve safely")
        }
        guard let data = item.data(forType: type) else {
          throw ControlError(
            "clipboard_unavailable", "A clipboard format cannot be safely preserved")
        }
        bytes += data.count
        guard bytes <= 64 * 1024 * 1024 else {
          throw ControlError("clipboard_unavailable", "Clipboard exceeds its preservation limit")
        }
        copy.setData(data, forType: type)
      }
      saved.append(copy)
    }
    try operation.check()
    guard board.changeCount == before else {
      throw ControlError(
        "clipboard_changed", "User changed clipboard; no clipboard input was submitted")
    }
    board.clearContents()
    var owned = board.changeCount
    let marker = NSPasteboard.PasteboardType("dev.zcode.cua.clipboard-owner")
    let identity = UUID().uuidString
    var wrote = false
    // 只恢复本操作仍持有的内容，用户的新剪贴板永远不被旧备份覆盖。
    defer {
      if board.changeCount == owned && (!wrote || board.string(forType: marker) == identity) {
        board.clearContents()
        if !saved.isEmpty { board.writeObjects(saved) }
      }
    }
    let temporary = NSPasteboardItem()
    temporary.setString(text, forType: .string)
    temporary.setString(identity, forType: marker)
    guard board.writeObjects([temporary]) else {
      throw ControlError("clipboard_unavailable", "Cannot write the temporary clipboard")
    }
    wrote = true
    owned = board.changeCount
    try shortcut(["key": "Cmd+V"], operation)
    _ = try await waitForSettled(operation, since: changeSequence)
  }
}
