// Modified by ZCode Feiyu.
import Foundation

struct TextSlice {
  let text: String
  let start: Int
  let end: Int
  let total: Int
}
// API 的偏移统一为 UTF-16；切点落在代理项中间时向前对齐，绝不返回破损字符。
func textSlice(_ value: String, offset: Int, length: Int) -> TextSlice {
  let units = Array(value.utf16)
  var start = min(max(0, offset), units.count)
  if start > 0 && start < units.count && (0xDC00...0xDFFF).contains(units[start]) { start -= 1 }
  var end = min(units.count, start + length)
  if end > start && end < units.count && (0xD800...0xDBFF).contains(units[end - 1]) { end -= 1 }
  if end == start && start < units.count { end = min(units.count, start + 2) }
  return TextSlice(text: String(decoding: units[start..<end], as: UTF16.self), start: start, end: end, total: units.count)
}
