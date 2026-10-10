// Modified by ZCode Feiyu contributors (2026).
#include "Control.hpp"
#include <aclapi.h>
#include <sddl.h>
#include <shlobj.h>

namespace {
struct Handle {
  HANDLE value;
  ~Handle() {
    if (value != INVALID_HANDLE_VALUE && value != nullptr)
      CloseHandle(value);
  }
};
struct LocalMemory {
  HLOCAL value = nullptr;
  ~LocalMemory() {
    if (value)
      LocalFree(value);
  }
};
struct PrivateUser {
  std::vector<BYTE> tokenData;
  LocalMemory descriptor;
  SECURITY_ATTRIBUTES attributes{};
  PSID sid() const {
    return reinterpret_cast<const TOKEN_USER *>(tokenData.data())->User.Sid;
  }
  PrivateUser() {
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
      throw Fault("lease_unavailable", "Device lease user is unavailable");
    Handle guard{token};
    DWORD size = 0;
    GetTokenInformation(token, TokenUser, nullptr, 0, &size);
    if (!size || size > 65536)
      throw Fault("lease_unavailable", "Invalid device lease user");
    tokenData.resize(size);
    if (!GetTokenInformation(token, TokenUser, tokenData.data(), size, &size))
      throw Fault("lease_unavailable", "Cannot resolve device lease user");
    LPWSTR stringSid = nullptr;
    if (!ConvertSidToStringSidW(sid(), &stringSid))
      throw Fault("lease_unavailable", "Cannot resolve device lease identity");
    LocalMemory sidGuard{stringSid};
    const std::wstring acl =
        L"D:P(A;;FA;;;SY)(A;;FA;;;" + std::wstring(stringSid) + L")";
    PSECURITY_DESCRIPTOR security = nullptr;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
            acl.c_str(), SDDL_REVISION_1, &security, nullptr))
      throw Fault("lease_unavailable", "Cannot create private device lease");
    descriptor.value = security;
    attributes = {sizeof(SECURITY_ATTRIBUTES), security, FALSE};
  }
  void verify(HANDLE object, bool directory) const {
    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(object, &info) ||
        (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
        ((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != directory)
      throw Fault("invalid_owner", "Invalid device lease object");
    PSID owner = nullptr;
    PACL acl = nullptr;
    PSECURITY_DESCRIPTOR security = nullptr;
    auto status =
        GetSecurityInfo(object, SE_FILE_OBJECT,
                        OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                        &owner, nullptr, &acl, nullptr, &security);
    LocalMemory guard{security};
    if (status != ERROR_SUCCESS || !owner || !EqualSid(owner, sid()) || !acl ||
        !IsValidAcl(acl))
      throw Fault("invalid_owner", "Device lease ownership is invalid");
    SECURITY_DESCRIPTOR_CONTROL control;
    DWORD revision = 0;
    if (!GetSecurityDescriptorControl(security, &control, &revision) ||
        !(control & SE_DACL_PROTECTED))
      throw Fault("invalid_owner", "Device lease permissions are not private");
    BYTE system[SECURITY_MAX_SID_SIZE];
    DWORD systemSize = sizeof(system);
    if (!CreateWellKnownSid(WinLocalSystemSid, nullptr, system, &systemSize))
      throw Fault("lease_unavailable",
                  "Cannot verify device lease permissions");
    bool allowsOwner = false;
    for (DWORD index = 0; index < acl->AceCount; index++) {
      void *entry = nullptr;
      if (!GetAce(acl, index, &entry) ||
          static_cast<ACE_HEADER *>(entry)->AceType != ACCESS_ALLOWED_ACE_TYPE)
        throw Fault("invalid_owner", "Unexpected device lease permissions");
      auto ace = static_cast<ACCESS_ALLOWED_ACE *>(entry);
      auto identity = reinterpret_cast<PSID>(&ace->SidStart);
      if (!IsValidSid(identity) ||
          (!EqualSid(identity, sid()) && !EqualSid(identity, system)))
        throw Fault("invalid_owner",
                    "Device lease is accessible to another user");
      if (EqualSid(identity, sid()) &&
          (ace->Mask & FILE_ALL_ACCESS) == FILE_ALL_ACCESS)
        allowsOwner = true;
    }
    if (!allowsOwner)
      throw Fault("invalid_owner",
                  "Device lease user cannot recover the device");
  }
};
bool neutralInput() {
  if (!interactiveDesktop())
    throw Fault("locked", "Interactive Windows desktop is unavailable");
  for (int key = 1; key < 256; key++)
    if (GetAsyncKeyState(key) & 0x8000)
      return false;
  return true;
}
} // namespace
bool nativeInputNeutral() { return neutralInput(); }

HANDLE DeviceLease::openExclusive() {
  PrivateUser user;
  PWSTR base = nullptr;
  check(SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_DEFAULT, nullptr,
                             &base),
        "Local device lease directory unavailable");
  std::wstring directory =
      std::wstring(base) + L"\\ZCodeComputerControlDevice-v1";
  CoTaskMemFree(base);
  if (!CreateDirectoryW(directory.c_str(), &user.attributes) &&
      GetLastError() != ERROR_ALREADY_EXISTS)
    throw Fault("lease_unavailable",
                "Cannot create private device lease directory");
  Handle dir{CreateFileW(
      directory.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  if (dir.value == INVALID_HANDLE_VALUE)
    throw Fault("lease_unavailable",
                "Cannot open private device lease directory");
  user.verify(dir.value, true);
  DWORD session = 0;
  if (!ProcessIdToSessionId(GetCurrentProcessId(), &session))
    throw Fault("lease_unavailable",
                "Cannot resolve interactive session identity");
  auto path = directory + L"\\input-" + std::to_wstring(session) + L".lock";
  auto file = CreateFileW(
      path.c_str(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL, 0,
      &user.attributes, OPEN_ALWAYS,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH, nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    const auto error = GetLastError();
    if (error == ERROR_SHARING_VIOLATION || error == ERROR_LOCK_VIOLATION)
      throw Fault("device_busy", "Another local Host owns native input");
    throw Fault("lease_unavailable", "Cannot open native input lease");
  }
  try {
    user.verify(file, false);
  } catch (...) {
    CloseHandle(file);
    throw;
  }
  return file;
}
DeviceLease::~DeviceLease() { abandon(); }
void DeviceLease::acquire(bool requireNeutral) {
  if (handle != INVALID_HANDLE_VALUE)
    return;
  handle = openExclusive();
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(handle, &size) || size.QuadPart != 0) {
    abandon();
    throw Fault("device_quarantined",
                "Previous input cleanup was not confirmed; continue from the "
                "trusted UI");
  }
  if (requireNeutral && !neutralInput()) {
    abandon();
    throw Fault(
        "foreground_required",
        "Release all keys and mouse buttons before controlling the computer");
  }
  // 操作前先持久标记；进程被强杀后句柄释放，标记仍阻断新 Host 自动接管。
  constexpr char marker[] = "zcode-cua-input-dirty-v1";
  DWORD written = 0;
  if (!WriteFile(handle, marker, sizeof(marker) - 1, &written, nullptr) ||
      written != sizeof(marker) - 1 || !FlushFileBuffers(handle)) {
    abandon();
    throw Fault("device_quarantined",
                "Device recovery state could not be persisted");
  }
}
void DeviceLease::clearMarker() {
  LARGE_INTEGER start{};
  if (!SetFilePointerEx(handle, start, nullptr, FILE_BEGIN) ||
      !SetEndOfFile(handle) || !FlushFileBuffers(handle))
    throw Fault("stop_unconfirmed",
                "Device recovery state could not be cleared",
                {{"outcome", "unknown"}});
}
void DeviceLease::release() {
  if (handle == INVALID_HANDLE_VALUE)
    return;
  clearMarker();
  abandon();
}
void DeviceLease::abandon() {
  if (handle != INVALID_HANDLE_VALUE)
    CloseHandle(handle);
  handle = INVALID_HANDLE_VALUE;
}
void DeviceLease::acknowledge() {
  if (!neutralInput())
    throw Fault("input_not_neutral",
                "Release all keys and mouse buttons before continuing");
  if (handle != INVALID_HANDLE_VALUE)
    return;
  handle = openExclusive();
  try {
    if (!neutralInput())
      throw Fault("input_not_neutral",
                  "Release all keys and mouse buttons before continuing");
    clearMarker();
  } catch (...) {
    abandon();
    throw;
  }
  abandon();
}
