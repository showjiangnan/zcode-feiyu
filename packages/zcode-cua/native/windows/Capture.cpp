// Modified by ZCode Feiyu contributors (2026).
#include "CaptureColor.hpp"
#include "Control.hpp"
#include <d3d11.h>
#include <dxgi.h>
#include <memory>
#include <wincodec.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/Windows.Graphics.DirectX.h>
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
using ::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess;
using winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
bool captureSupported() {
  try { return GraphicsCaptureSession::IsSupported(); } catch (...) { return false; }
}
struct CaptureDisplay {
  HMONITOR monitor;
  bool linear;
  float whiteLevel;
  bool operator==(const CaptureDisplay &) const = default;
};
static CaptureDisplay captureDisplay(HWND window) {
  auto monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
  MONITORINFOEXW info{};
  info.cbSize = sizeof(info);
  if (!monitor ||
      !GetMonitorInfoW(monitor, reinterpret_cast<MONITORINFO *>(&info)))
    throw Fault("color_configuration_unavailable",
                "Capture display is unavailable");
  for (int attempt = 0; attempt < 3; attempt++) {
    UINT32 pathCount = 0, modeCount = 0;
    if (GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &pathCount,
                                    &modeCount) != ERROR_SUCCESS ||
        !pathCount || pathCount > 256 || modeCount > 2048)
      throw Fault("color_configuration_unavailable",
                  "Display color configuration is unavailable");
    std::vector<DISPLAYCONFIG_PATH_INFO> paths(pathCount);
    std::vector<DISPLAYCONFIG_MODE_INFO> modes(modeCount);
    auto status =
        QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &pathCount, paths.data(),
                           &modeCount, modes.data(), nullptr);
    if (status == ERROR_INSUFFICIENT_BUFFER)
      continue;
    if (status != ERROR_SUCCESS)
      throw Fault("color_configuration_unavailable",
                  "Display color configuration cannot be read");
    for (UINT32 index = 0; index < pathCount; index++) {
      const auto &path = paths[index];
      DISPLAYCONFIG_SOURCE_DEVICE_NAME name{};
      name.header = {DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, sizeof(name),
                     path.sourceInfo.adapterId, path.sourceInfo.id};
      if (DisplayConfigGetDeviceInfo(&name.header) != ERROR_SUCCESS ||
          _wcsicmp(name.viewGdiDeviceName, info.szDevice) != 0)
        continue;
      DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO color{};
      color.header = {DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO,
                      sizeof(color), path.targetInfo.adapterId,
                      path.targetInfo.id};
      auto colorStatus = DisplayConfigGetDeviceInfo(&color.header);
      if (colorStatus == ERROR_NOT_SUPPORTED)
        return {monitor, false, 1.0f};
      if (colorStatus != ERROR_SUCCESS)
        throw Fault("color_configuration_unavailable",
                    "Advanced display color state is unavailable");
      if (!color.advancedColorEnabled)
        return {monitor, false, 1.0f};
      DISPLAYCONFIG_SDR_WHITE_LEVEL white{};
      white.header = {DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL,
                      sizeof(white), path.targetInfo.adapterId,
                      path.targetInfo.id};
      if (DisplayConfigGetDeviceInfo(&white.header) != ERROR_SUCCESS ||
          !white.SDRWhiteLevel || white.SDRWhiteLevel > 1000000)
        throw Fault("color_configuration_unavailable",
                    "Display SDR white level is unavailable");
      return {monitor, true, static_cast<float>(white.SDRWhiteLevel) / 1000.0f};
    }
    throw Fault("color_configuration_unavailable",
                "Capture display identity changed");
  }
  throw Fault("inconsistent_observation",
              "Display configuration changed during capture");
}
static std::string base64(const std::vector<BYTE> &data) {
  static const char *alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string output;
  output.reserve((data.size() + 2) / 3 * 4);
  for (size_t i = 0; i < data.size(); i += 3) {
    unsigned value = (unsigned)data[i] << 16;
    if (i + 1 < data.size())
      value |= (unsigned)data[i + 1] << 8;
    if (i + 2 < data.size())
      value |= data[i + 2];
    output += alphabet[(value >> 18) & 63];
    output += alphabet[(value >> 12) & 63];
    output += i + 1 < data.size() ? alphabet[(value >> 6) & 63] : '=';
    output += i + 2 < data.size() ? alphabet[value & 63] : '=';
  }
  return output;
}
static std::vector<BYTE> encode(const BYTE *pixels, UINT width, UINT height,
                                UINT stride, UINT outputWidth,
                                UINT outputHeight, WICRect crop, bool preview) {
  ComPtr<IWICImagingFactory> factory;
  check(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                         IID_PPV_ARGS(&factory)),
        "WIC unavailable");
  ComPtr<IWICBitmap> bitmap;
  check(factory->CreateBitmapFromMemory(
            width, height, GUID_WICPixelFormat32bppBGRA, stride,
            stride * height, const_cast<BYTE *>(pixels), &bitmap),
        "Bitmap conversion failed");
  ComPtr<IWICBitmapScaler> scaled;
  check(factory->CreateBitmapScaler(&scaled), "Scaler unavailable");
  ComPtr<IWICBitmapClipper> clipped;
  check(factory->CreateBitmapClipper(&clipped), "Crop unavailable");
  check(clipped->Initialize(bitmap.Get(), &crop), "Crop failed");
  check(scaled->Initialize(clipped.Get(), outputWidth, outputHeight,
                           WICBitmapInterpolationModeFant),
        "Preview scaling failed");
  ComPtr<IStream> stream;
  check(CreateStreamOnHGlobal(nullptr, TRUE, &stream),
        "Image stream unavailable");
  ComPtr<IWICBitmapEncoder> encoder;
  check(factory->CreateEncoder(preview ? GUID_ContainerFormatJpeg
                                       : GUID_ContainerFormatPng,
                               nullptr, &encoder),
        "PNG encoder unavailable");
  check(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache),
        "PNG stream failed");
  ComPtr<IWICBitmapFrameEncode> encoded;
  check(encoder->CreateNewFrame(&encoded, nullptr), "PNG frame failed");
  check(encoded->Initialize(nullptr), "PNG initialization failed");
  check(encoded->SetSize(outputWidth, outputHeight), "PNG dimensions failed");
  WICPixelFormatGUID format =
      preview ? GUID_WICPixelFormat24bppBGR : GUID_WICPixelFormat32bppBGRA;
  check(encoded->SetPixelFormat(&format), "PNG pixel format failed");
  ComPtr<IWICFormatConverter> converted;
  check(factory->CreateFormatConverter(&converted),
        "Pixel converter unavailable");
  check(converted->Initialize(scaled.Get(), format, WICBitmapDitherTypeNone,
                              nullptr, 0, WICBitmapPaletteTypeCustom),
        "Pixel conversion failed");
  check(encoded->WriteSource(converted.Get(), nullptr), "PNG pixels failed");
  check(encoded->Commit(), "PNG frame commit failed");
  check(encoder->Commit(), "PNG commit failed");
  STATSTG status{};
  check(stream->Stat(&status, STATFLAG_NONAME), "PNG stream size failed");
  if (status.cbSize.QuadPart > 32000000)
    throw Fault("image_too_large", "PNG exceeds the media limit");
  std::vector<BYTE> data((size_t)status.cbSize.QuadPart);
  LARGE_INTEGER start{};
  check(stream->Seek(start, STREAM_SEEK_SET, nullptr), "PNG seek failed");
  ULONG read = 0;
  check(stream->Read(data.data(), (ULONG)data.size(), &read),
        "PNG read failed");
  if (read != data.size())
    throw Fault("capture_failed", "PNG stream is incomplete");
  return data;
}
Raster captureWindow(const Target &target, const Operation &operation,
                     bool preview, const Json &input) {
  operation.guard();
  const auto display = captureDisplay(target.hwnd);
  if (!GraphicsCaptureSession::IsSupported())
    throw Fault("capture_unsupported",
                "Windows Graphics Capture is unavailable");
  auto factory = winrt::get_activation_factory<GraphicsCaptureItem,
                                               IGraphicsCaptureItemInterop>();
  GraphicsCaptureItem item{nullptr};
  check(factory->CreateForWindow(target.hwnd,
                                 winrt::guid_of<GraphicsCaptureItem>(),
                                 winrt::put_abi(item)),
        "Approved window cannot be captured");
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  D3D_FEATURE_LEVEL level;
  HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                 D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                                 D3D11_SDK_VERSION, &device, &level, &context);
  if (FAILED(hr))
    check(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr,
                            D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                            D3D11_SDK_VERSION, &device, &level, &context),
          "D3D11 device creation failed");
  ComPtr<IDXGIDevice> dxgi;
  check(device.As(&dxgi), "DXGI interface unavailable");
  winrt::com_ptr<IInspectable> inspectable;
  check(CreateDirect3D11DeviceFromDXGIDevice(dxgi.Get(), inspectable.put()),
        "Capture device unavailable");
  auto projected = inspectable.as<IDirect3DDevice>();
  auto size = item.Size();
  if (size.Width <= 0 || size.Height <= 0 || size.Width > 16384 ||
      size.Height > 16384 || (uint64_t)size.Width * size.Height > 16777216)
    throw Fault("invalid_capture_size",
                "Window dimensions exceed capture limits");
  auto pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
      projected,
      display.linear ? DirectXPixelFormat::R16G16B16A16Float
                     : DirectXPixelFormat::B8G8R8A8UIntNormalized,
      2, size);
  auto session = pool.CreateCaptureSession(item);
  session.IsCursorCaptureEnabled(false);
  struct Wait {
    std::mutex mutex;
    std::condition_variable condition;
    Direct3D11CaptureFrame frame{nullptr};
    bool closed = false;
    bool failed = false;
  };
  auto wait = std::make_shared<Wait>();
  // 事件处理器持有共享等待状态，解绑后迟到回调也不会引用已离开栈帧的数据。
  auto closedToken = item.Closed([wait](auto &&, auto &&) {
    std::lock_guard<std::mutex> lock(wait->mutex);
    wait->closed = true;
    wait->condition.notify_one();
  });
  auto frameToken = pool.FrameArrived([wait](auto &&sender, auto &&) {
    std::lock_guard<std::mutex> lock(wait->mutex);
    if (!wait->closed && !wait->frame) {
      try {
        wait->frame = sender.TryGetNextFrame();
      } catch (...) {
        wait->failed = true;
        wait->closed = true;
      }
    }
    wait->condition.notify_one();
  });
  struct Close {
    Direct3D11CaptureFramePool pool;
    GraphicsCaptureSession session;
    GraphicsCaptureItem item;
    winrt::event_token frameToken, closedToken;
    std::shared_ptr<Wait> wait;
    ~Close() {
      {
        std::lock_guard<std::mutex> lock(wait->mutex);
        wait->closed = true;
        wait->frame = nullptr;
      }
      // 取消/失败同样先关闭回调准入；解绑一项失败不能跳过剩余原生资源回收。
      try {
        pool.FrameArrived(frameToken);
      } catch (...) {
      }
      try {
        item.Closed(closedToken);
      } catch (...) {
      }
      try {
        session.Close();
      } catch (...) {
      }
      try {
        pool.Close();
      } catch (...) {
      }
    }
  } close{pool, session, item, frameToken, closedToken, wait};
  session.StartCapture();
  Direct3D11CaptureFrame frame{nullptr};
  {
    std::unique_lock<std::mutex> lock(wait->mutex);
    while (!wait->frame && !wait->closed) {
      wait->condition.wait_for(lock, std::chrono::milliseconds(20));
      operation.guard();
    }
    if (wait->failed)
      throw Fault("capture_failed", "Native capture frame acquisition failed");
    if (wait->closed || !wait->frame)
      throw Fault("target_unavailable", "Capture target closed");
    frame = wait->frame;
    wait->closed = true;
  }
  auto actual = frame.ContentSize();
  if (actual.Width != size.Width || actual.Height != size.Height)
    throw Fault("inconsistent_observation", "Window resized while capturing");
  auto surface = frame.Surface().as<IDirect3DDxgiInterfaceAccess>();
  ComPtr<ID3D11Texture2D> texture;
  check(surface->GetInterface(IID_PPV_ARGS(&texture)),
        "Capture texture unavailable");
  D3D11_TEXTURE2D_DESC description{};
  texture->GetDesc(&description);
  const auto expectedFormat = display.linear ? DXGI_FORMAT_R16G16B16A16_FLOAT
                                             : DXGI_FORMAT_B8G8R8A8_UNORM;
  if (description.Format != expectedFormat ||
      description.Width < static_cast<UINT>(size.Width) ||
      description.Height < static_cast<UINT>(size.Height))
    throw Fault("capture_failed", "Unexpected capture texture layout");
  description.Usage = D3D11_USAGE_STAGING;
  description.BindFlags = 0;
  description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  description.MiscFlags = 0;
  ComPtr<ID3D11Texture2D> staging;
  check(device->CreateTexture2D(&description, nullptr, &staging),
        "Capture readback unavailable");
  context->CopyResource(staging.Get(), texture.Get());
  D3D11_MAPPED_SUBRESOURCE mapped{};
  check(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped),
        "Capture readback failed");
  struct Unmap {
    ID3D11DeviceContext *context;
    ID3D11Texture2D *texture;
    ~Unmap() { context->Unmap(texture, 0); }
  } unmap{context.Get(), staging.Get()};
  const UINT bytesPerPixel = display.linear ? 8 : 4;
  if (mapped.RowPitch < static_cast<UINT>(size.Width) * bytesPerPixel)
    throw Fault("capture_failed", "Capture row stride is invalid");
  std::vector<BYTE> sdr;
  const BYTE *pixels = static_cast<const BYTE *>(mapped.pData);
  UINT stride = mapped.RowPitch;
  if (display.linear) {
    stride = static_cast<UINT>(size.Width) * 4;
    sdr.resize(static_cast<size_t>(stride) * size.Height);
    for (int row = 0; row < size.Height; row++) {
      if (row % 32 == 0)
        operation.guard();
      const auto source = reinterpret_cast<const std::uint16_t *>(
          static_cast<const BYTE *>(mapped.pData) +
          static_cast<size_t>(row) * mapped.RowPitch);
      auto output = sdr.data() + static_cast<size_t>(row) * stride;
      for (int column = 0; column < size.Width; column++) {
        auto color = CaptureColor::toBgra(
            {source[column * 4], source[column * 4 + 1], source[column * 4 + 2],
             source[column * 4 + 3]},
            display.whiteLevel);
        std::copy(color.begin(), color.end(), output + column * 4);
      }
    }
    pixels = sdr.data();
  }
  double logicalWidth = target.bounds.right - target.bounds.left,
         logicalHeight = target.bounds.bottom - target.bounds.top;
  double left = 0, top = 0, cropWidth = logicalWidth,
         cropHeight = logicalHeight;
  if (!preview && input.contains("region")) {
    auto region = input.at("region");
    left = number(region, "x");
    top = number(region, "y");
    cropWidth = number(region, "width");
    cropHeight = number(region, "height");
    if (left < 0 || top < 0 || cropWidth <= 0 || cropHeight <= 0 ||
        left + cropWidth > logicalWidth || top + cropHeight > logicalHeight)
      throw Fault("out_of_bounds", "Crop is outside the approved window");
  }
  WICRect crop{(INT)std::floor(left * size.Width / logicalWidth),
               (INT)std::floor(top * size.Height / logicalHeight),
               (INT)std::floor(cropWidth * size.Width / logicalWidth),
               (INT)std::floor(cropHeight * size.Height / logicalHeight)};
  if (crop.Width <= 0 || crop.Height <= 0)
    throw Fault("out_of_bounds", "Crop has no pixels");
  RECT bounds{target.bounds.left + (LONG)std::lround(left),
              target.bounds.top + (LONG)std::lround(top),
              target.bounds.left + (LONG)std::lround(left + cropWidth),
              target.bounds.top + (LONG)std::lround(top + cropHeight)};
  double scale = std::min(1.0, (preview ? 1280.0 : 2000.0) /
                                   std::max(crop.Width, crop.Height));
  std::vector<BYTE> data;
  UINT width = 0, height = 0;
  for (int attempt = 0; attempt < 10; attempt++) {
    operation.guard();
    width = std::max(1, (int)(crop.Width * scale));
    height = std::max(1, (int)(crop.Height * scale));
    data = encode(pixels, size.Width, size.Height, stride, width, height, crop,
                  preview);
    if (data.size() <= (preview ? 1500000 : 3500000))
      break;
    if (attempt == 9)
      throw Fault("image_too_large", "Encoded image exceeds the media limit");
    scale *= 0.75;
  }
  operation.guard();
  if (captureDisplay(target.hwnd) != display)
    throw Fault("inconsistent_observation",
                "Capture display color configuration changed");
  return {base64(data), (int)width, (int)height, bounds,
          preview ? "image/jpeg" : "image/png"};
}
