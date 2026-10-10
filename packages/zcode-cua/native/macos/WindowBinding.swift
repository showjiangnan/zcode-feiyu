// Modified by ZCode Feiyu contributors (2026).
import Foundation
import CoreGraphics

func windowFramesMatch(_ first: CGRect, _ second: CGRect) -> Bool {
  abs(first.minX - second.minX) < 1 && abs(first.minY - second.minY) < 1
    && abs(first.width - second.width) < 1 && abs(first.height - second.height) < 1
}

func uniqueAccessibilityWindowIndex(
  frame: CGRect, processWindowFrames: [CGRect], accessibilityFrames: [CGRect?]
) -> Int? {
  // 标题是展示数据，不是稳定身份；同进程两侧几何都唯一才建立映射，重叠窗口不猜测。
  guard processWindowFrames.filter({ windowFramesMatch($0, frame) }).count == 1 else { return nil }
  let matches = accessibilityFrames.indices.filter { index in
    accessibilityFrames[index].map { windowFramesMatch($0, frame) } ?? false
  }
  return matches.count == 1 ? matches.first : nil
}

func isolatedPointWindow(_ point: CGPoint, windows: [(id: CGWindowID, frame: CGRect)]) -> CGWindowID? {
  // 调用者仅传入目标进程的真实可见窗口栈；其他应用的遮挡不能影响定向事件。
  windows.first(where: { $0.frame.contains(point) })?.id
}
