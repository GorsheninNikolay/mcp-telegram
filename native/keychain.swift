import Foundation
import Security

// Requests and secret responses use pipes only. Errors deliberately contain no input.
do {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard data.count <= 65536,
          let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let operation = request["operation"] as? String,
          let account = request["account"] as? String,
          account == "api-credentials" || account.range(of: "^session-[a-f0-9]{64}$", options: .regularExpression) != nil
    else { exit(1) }
    if request["interactive"] as? Bool != true { SecKeychainSetUserInteractionAllowed(false) }
    var query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "io.github.GorsheninNikolay.telegram-mcp",
        kSecAttrAccount as String: account
    ]
    #if KEYCHAIN_INTEGRATION_TEST
    guard let testPath = ProcessInfo.processInfo.environment["TELEGRAM_TEST_KEYCHAIN"] else { exit(1) }
    var testKeychain: SecKeychain?
    guard SecKeychainOpen(testPath, &testKeychain) == errSecSuccess, let isolated = testKeychain else { exit(1) }
    query[kSecMatchSearchList as String] = [isolated]
    query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail
    #endif
    var value: Any = NSNull()
    switch operation {
    case "load":
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &result)
        if status == errSecSuccess {
            guard let bytes = result as? Data, let secret = String(data: bytes, encoding: .utf8) else { exit(1) }
            value = secret
        } else if status != errSecItemNotFound { exit(1) }
    case "save":
        guard let secret = request["value"] as? String, let bytes = secret.data(using: .utf8) else { exit(1) }
        let attributes = [kSecValueData as String: bytes]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            #if KEYCHAIN_INTEGRATION_TEST
            item.removeValue(forKey: kSecMatchSearchList as String)
            item[kSecUseKeychain as String] = isolated
            #endif
            item[kSecValueData as String] = bytes
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { exit(1) }
    case "delete":
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { exit(1) }
    default: exit(1)
    }
    let response = try JSONSerialization.data(withJSONObject: ["value": value])
    FileHandle.standardOutput.write(response)
} catch { exit(1) }
