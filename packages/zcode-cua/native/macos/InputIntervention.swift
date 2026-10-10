// Modified by ZCode Feiyu contributors (2026).
enum InputIntervention { case ignore, pause, stop }

func inputIntervention(ownEvent: Bool, hasOwner: Bool, targetsWindow: Bool,
  escape: Bool, foregroundRoute: Bool) -> InputIntervention {
  guard !ownEvent, hasOwner else { return .ignore }
  // 全局 Esc 曾误停后台任务；只有准确受控窗口中的 Esc 才是明确停止。
  if targetsWindow { return escape ? .stop : .pause }
  return foregroundRoute ? .pause : .ignore
}
