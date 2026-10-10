// Modified by ZCode Feiyu contributors (2026).
#pragma once
#include <algorithm>
#include <cmath>
struct FeedbackPoint { double x = 0, y = 0; };
inline FeedbackPoint feedbackMotion(FeedbackPoint from, FeedbackPoint to, double progress) {
  const double t = std::clamp(progress, 0.0, 1.0);
  const double eased = t * t * (3.0 - 2.0 * t);
  return {from.x + (to.x - from.x) * eased, from.y + (to.y - from.y) * eased};
}
