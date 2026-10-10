// Modified by ZCode Feiyu contributors (2026).
#pragma once
#include <cmath>
#include <cstdint>
#include <stdexcept>
#include <string_view>
namespace zcode::input {
struct ScanCode { uint16_t scan; bool extended; };
inline ScanCode physicalScan(double value, bool extended) {
  if (!std::isfinite(value) || value < 1 || value > 511 || value != std::floor(value) || (static_cast<unsigned>(value) & 255) == 0)
    throw std::invalid_argument("Invalid physical scan code");
  return {static_cast<uint16_t>(static_cast<unsigned>(value) & 255), extended || value > 255};
}
inline std::string_view keyAlias(std::string_view key) { return key == "return" ? "enter" : key; }
// WM_MOUSEWHEEL 是刻度单位，不是像素；像素/points 必须明确是按行高估计。
inline double wheelDelta(double distance, std::string_view unit, double dpi, double extent, unsigned perNotch) {
  if (!std::isfinite(distance) || std::abs(distance) > 100000 || dpi <= 0 || extent <= 0)
    throw std::invalid_argument("Invalid scroll geometry or magnitude");
  if (!perNotch) return 0; // 用户系统设置禁止此轴滚动。
  const double line = 16 * dpi / 96;
  const bool pageSetting = perNotch == UINT32_MAX;
  const double pixelsPerNotch = pageSetting ? extent : perNotch * line;
  if (unit == "lines") return distance * line * 120 / pixelsPerNotch;
  if (unit == "pages") return distance * extent * 120 / pixelsPerNotch;
  if (unit == "points") return distance * dpi / 96 * 120 / pixelsPerNotch;
  if (unit == "pixels") return distance * 120 / pixelsPerNotch;
  throw std::invalid_argument("Unknown scroll unit");
}
inline int accumulateWheel(double value, double &remainder) {
  const double total = value + remainder;
  if (!std::isfinite(total) || std::abs(total) > 32767) throw std::invalid_argument("Scroll magnitude exceeds message range");
  const int integral = static_cast<int>(total);
  remainder = total - integral;
  return integral;
}
}
