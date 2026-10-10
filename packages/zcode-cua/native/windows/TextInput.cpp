// Modified by ZCode Feiyu contributors (2026).
#include "Control.hpp"
struct ClipboardLock {
  bool held;
  explicit ClipboardLock(HWND window) : held(OpenClipboard(window) != FALSE) {
    if (!held)
      throw Fault("clipboard_busy", "Clipboard is owned by another operation");
  }
  ~ClipboardLock() {
    if (held)
      CloseClipboard();
  }
};
static HGLOBAL copyData(const std::vector<BYTE> &bytes) {
  auto handle = GlobalAlloc(GMEM_MOVEABLE, bytes.size());
  if (!handle)
    throw Fault("clipboard_unavailable",
                "Cannot allocate clipboard preservation memory");
  auto data = GlobalLock(handle);
  if (!data) {
    GlobalFree(handle);
    throw Fault("clipboard_unavailable", "Cannot preserve clipboard data");
  }
  memcpy(data, bytes.data(), bytes.size());
  GlobalUnlock(handle);
  return handle;
}
void pasteText(const std::string &text, const Target &target,
               const Operation &operation,
               const std::function<void(std::vector<INPUT>)> &send) {
  HWND window = CreateWindowExW(0, L"STATIC", L"ZCodeComputerClipboard", 0, 0,
                                0, 0, 0, HWND_MESSAGE, nullptr,
                                GetModuleHandleW(nullptr), nullptr);
  if (!window)
    throw Fault("clipboard_unavailable",
                "Cannot create a private clipboard owner");
  struct WindowClose {
    HWND value;
    ~WindowClose() { DestroyWindow(value); }
  } windowClose{window};
  std::vector<std::pair<UINT, std::vector<BYTE>>> saved;
  DWORD owned = 0;
  size_t total = 0;
  {
    ClipboardLock lock(window);
    for (UINT format = EnumClipboardFormats(0); format;
         format = EnumClipboardFormats(format)) {
      // 无法复制 GDI/嵌入式元文件句柄时先拒绝；不能把悬空句柄当成可恢复格式。
      if (format == CF_BITMAP || format == CF_DSPBITMAP ||
          format == CF_PALETTE || format == CF_METAFILEPICT ||
          format == CF_DSPMETAFILEPICT || format == CF_ENHMETAFILE ||
          format == CF_DSPENHMETAFILE || format == CF_OWNERDISPLAY)
        throw Fault("clipboard_unavailable",
                    "This clipboard format cannot be preserved safely");
      auto handle = GetClipboardData(format);
      SIZE_T length = handle ? GlobalSize(handle) : 0;
      if (!length || length > 64 * 1024 * 1024 ||
          total + length > 64 * 1024 * 1024 || saved.size() >= 128)
        throw Fault("clipboard_unavailable",
                    "Clipboard exceeds its preservation contract");
      auto data = static_cast<BYTE *>(GlobalLock(handle));
      if (!data)
        throw Fault("clipboard_unavailable",
                    "Clipboard format cannot be copied safely");
      saved.push_back({format, std::vector<BYTE>(data, data + length)});
      GlobalUnlock(handle);
      total += length;
    }
    operation.guard();
    auto value = wide(text);
    value.push_back(0);
    std::vector<BYTE> bytes(reinterpret_cast<BYTE *>(value.data()),
                            reinterpret_cast<BYTE *>(value.data()) +
                                value.size() * sizeof(wchar_t));
    auto handle = copyData(bytes);
    if (!EmptyClipboard()) {
      GlobalFree(handle);
      throw Fault("clipboard_unavailable", "Cannot obtain clipboard ownership");
    }
    if (!SetClipboardData(CF_UNICODETEXT, handle)) {
      GlobalFree(handle);
      for (auto &item : saved) {
        auto restore = copyData(item.second);
        if (!SetClipboardData(item.first, restore))
          GlobalFree(restore);
      }
      throw Fault("clipboard_unavailable",
                  "Temporary clipboard could not be written");
    }
    owned = GetClipboardSequenceNumber();
  }
  struct Restore {
    HWND window;
    DWORD owned;
    std::vector<std::pair<UINT, std::vector<BYTE>>> &saved;
    ~Restore() {
      try {
        ClipboardLock lock(window);
        if (GetClipboardSequenceNumber() != owned)
          return;
        if (!EmptyClipboard())
          return;
        for (auto &item : saved) {
          auto handle = copyData(item.second);
          if (!SetClipboardData(item.first, handle))
            GlobalFree(handle);
        }
      } catch (...) {
      }
    }
  } restore{window, owned, saved};
  operation.guard();
  INPUT control{}, down{}, up{}, release{};
  control.type = down.type = up.type = release.type = INPUT_KEYBOARD;
  control.ki.wVk = release.ki.wVk = VK_CONTROL;
  down.ki.wVk = up.ki.wVk = 'V';
  up.ki.dwFlags = release.ki.dwFlags = KEYEVENTF_KEYUP;
  for (auto event : {&control, &down, &up, &release})
    event->ki.dwExtraInfo = InputTag;
  send({control, down, up, release});
  // 剪贴板读取由目标线程处理后才恢复。仅同步目标消息，不将消息处理成功当作文本已验证。
  DWORD_PTR ignored = 0;
  SendMessageTimeoutW(target.hwnd, WM_NULL, 0, 0, SMTO_ABORTIFHUNG, 1000,
                      &ignored);
  operation.guard();
}
