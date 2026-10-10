// Modified by ZCode Feiyu contributors (2026).
import Foundation
import CoreGraphics

func controlBadgeFrame(window: CGRect, screens: [CGRect], size: CGSize, inset: Double) -> CGRect? {
  guard window.width >= size.width + 12, window.height >= size.height + 12,
    screens.contains(where: { $0.intersects(window) }) else { return nil }
  let x = min(window.maxX - size.width - 6, window.minX + inset)
  let frame = CGRect(x: max(window.minX + 6, x), y: window.minY + 6, width: size.width, height: size.height)
  return screens.contains(where: { $0.contains(frame) }) ? frame : nil
}
func appKitOverlayFrame(_ frame: CGRect, primaryHeight: Double) -> CGRect {
  CGRect(x: frame.minX, y: primaryHeight - frame.maxY, width: frame.width, height: frame.height)
}
struct AgentPointerMotion {
  let from: CGPoint
  let to: CGPoint
  let started: Double
  let duration: Double
  func position(at time: Double) -> CGPoint {
    let t = min(1, max(0, (time - started) / max(0.001, duration)))
    let eased = t * t * (3 - 2 * t)
    return CGPoint(x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased)
  }
}
