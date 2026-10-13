// Modified by ZCode Feiyu.
import CoreGraphics

func registeredWindowClosed(onScreen: Bool?, applicationHidden: Bool,
  knownWindowIds: [CGWindowID?]?, target: CGWindowID, layer: Int, minimizedRoot: Bool) -> Bool {
  // 离屏不能单独证明关闭；完整原生身份集合缺少旧窗口才构成关闭证据。
  guard onScreen == false, !applicationHidden, let ids = knownWindowIds,
    ids.allSatisfy({ $0 != nil }), !ids.contains(where: { $0 == target }),
    layer == 0 || !minimizedRoot else { return false }
  return true
}
