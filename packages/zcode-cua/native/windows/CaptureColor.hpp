// Modified by ZCode Feiyu contributors (2026).
#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

namespace CaptureColor {
inline float half(std::uint16_t value) {
  const unsigned exponent = (value >> 10) & 31;
  const unsigned fraction = value & 1023;
  if (exponent == 31)
    return 0;
  const float magnitude =
      exponent == 0 ? std::ldexp(static_cast<float>(fraction), -24)
                    : std::ldexp(1.0f + static_cast<float>(fraction) / 1024,
                                 static_cast<int>(exponent) - 15);
  return value & 0x8000 ? -magnitude : magnitude;
}
inline std::uint8_t srgb(float linear) {
  if (!std::isfinite(linear))
    return 0;
  linear = std::clamp(linear, 0.0f, 1.0f);
  const float encoded = linear <= 0.0031308f
                            ? 12.92f * linear
                            : 1.055f * std::pow(linear, 1.0f / 2.4f) - 0.055f;
  return static_cast<std::uint8_t>(
      std::lround(std::clamp(encoded, 0.0f, 1.0f) * 255));
}
inline std::array<std::uint8_t, 4>
toBgra(const std::array<std::uint16_t, 4> &rgba, float whiteLevel) {
  const float alpha = std::clamp(half(rgba[3]), 0.0f, 1.0f);
  if (alpha == 0 || !std::isfinite(whiteLevel) || whiteLevel <= 0)
    return {0, 0, 0, 0};
  std::array<float, 3> rgb;
  for (unsigned channel = 0; channel < 3; channel++)
    rgb[channel] = std::max(0.0f, half(rgba[channel]) / alpha / whiteLevel);
  // scRGB 以 80 nits 为 1；先按显示器 SDR
  // 白点归一化，再统一压缩亮部，避免逐通道剪裁改变色相。
  const float peak = std::max({rgb[0], rgb[1], rgb[2]});
  constexpr float shoulder = 0.85f;
  if (peak > shoulder) {
    const float excess = peak - shoulder;
    const float mapped =
        shoulder + excess / (1.0f + excess / (1.0f - shoulder));
    for (auto &channel : rgb)
      channel *= mapped / peak;
  }
  return {srgb(rgb[2]), srgb(rgb[1]), srgb(rgb[0]),
          static_cast<std::uint8_t>(std::lround(alpha * 255))};
}
} // namespace CaptureColor
