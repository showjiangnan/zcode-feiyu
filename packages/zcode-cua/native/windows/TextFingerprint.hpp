// Modified by ZCode Feiyu.
#pragma once
#include <bcrypt.h>

inline std::string textFingerprint(const std::string &text) {
  // 使用系统 SHA-256 保存并发校验事实；不把长文本原文留在观察缓存中。
  struct Provider {
    BCRYPT_ALG_HANDLE handle = nullptr;
    Provider() { if (BCryptOpenAlgorithmProvider(&handle, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) throw Fault("text_fingerprint_unavailable", "Text validation is unavailable"); }
    ~Provider() { BCryptCloseAlgorithmProvider(handle, 0); }
  };
  static Provider provider;
  if (text.size() > 16000000) throw Fault("text_limit", "Text exceeds the bounded reader");
  unsigned char digest[32];
  if (BCryptHash(provider.handle, nullptr, 0, reinterpret_cast<PUCHAR>(const_cast<char *>(text.data())), static_cast<ULONG>(text.size()), digest, sizeof(digest)) < 0)
    throw Fault("text_fingerprint_unavailable", "Text validation failed");
  constexpr char hex[] = "0123456789abcdef";
  std::string result; result.reserve(64);
  for (auto byte : digest) { result += hex[byte >> 4]; result += hex[byte & 15]; }
  return result;
}
