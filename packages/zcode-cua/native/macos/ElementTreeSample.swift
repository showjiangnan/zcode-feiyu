// Modified by ZCode Feiyu.
import Foundation

struct ElementTreeRecord<Element> {
  let element: Element
  let path: String
  let row: [String: Any]
}
struct ElementTreeSample<Element> {
  let records: [ElementTreeRecord<Element>]
  let continuations: [[String: Any]]
}
// 节点分页保持父节点和绝对路径。适配器只负责读取原生属性，遍历规则可独立验证。
func sampleElementTree<Element>(
  root: Element, rootPath: String, childOffset: Int, maximum: Int,
  check: () throws -> Void, equal: (Element, Element) -> Bool,
  describe: (Element, String) throws -> [String: Any],
  children: (Element, Int, Int) throws -> (count: Int, values: [Element])
) throws -> ElementTreeSample<Element> {
  var stack: [(Element, String, Int)] = [(root, rootPath, 0)]
  var records: [ElementTreeRecord<Element>] = []
  var visited: [Element] = []
  var continuation: [[String: Any]] = []
  while let (element, path, depth) = stack.popLast() {
    try check()
    if visited.contains(where: { equal($0, element) }) { continue }
    visited.append(element)
    let row = try describe(element, path)
    records.append(ElementTreeRecord(element: element, path: path, row: row))
    let offset = path == rootPath ? childOffset : 0
    let remaining = depth >= 128 ? 0 : max(0, maximum - records.count - stack.count)
    let result = try children(element, offset, remaining)
    let end = offset + result.values.count
    if result.count > end { continuation.append(["elementId": row["elementId"]!, "offset": end]) }
    for (index, child) in result.values.enumerated().reversed() { stack.append((child, "\(path).\(offset + index)", depth + 1)) }
  }
  return ElementTreeSample(records: records, continuations: continuation)
}
