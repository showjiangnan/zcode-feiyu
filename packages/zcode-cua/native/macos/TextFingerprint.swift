// Modified by ZCode Feiyu.
import CryptoKit
import Foundation

func textFingerprint(_ text: String) -> String {
  SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
}
