import Foundation
import Security

// This helper has a single bounded stdin/stdout JSON protocol. Never log payloads.
let maximumBytes = 1024 * 1024
let service = "kakao-headless"

func reply(_ object: [String: Any]) -> Never {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          data.count <= maximumBytes else {
        FileHandle.standardOutput.write(Data("{\"ok\":false}".utf8))
        exit(1)
    }
    FileHandle.standardOutput.write(data)
    exit(0)
}
func fail() -> Never { reply(["ok": false]) }

// Read in a loop: a pipe may return a partial chunk before EOF.
var input = Data()
do {
    while let chunk = try FileHandle.standardInput.read(upToCount: min(65536, maximumBytes + 1 - input.count)), !chunk.isEmpty {
        input.append(chunk)
        if input.count > maximumBytes { fail() }
    }
} catch { fail() }
guard let request = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any],
      let action = request["action"] as? String,
      ["get", "set", "delete"].contains(action),
      let requestedService = request["service"] as? String, requestedService == service,
      let account = request["account"] as? String,
      ["account", "pending"].contains(account) else { fail() }
let allowedKeys: Set<String> = action == "set" ? ["action", "service", "account", "value"] : ["action", "service", "account"]
guard Set(request.keys) == allowedKeys else { fail() }

let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
    kSecAttrSynchronizable as String: false
]

switch action {
case "get":
    var lookup = query
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &result)
    if status == errSecItemNotFound { reply(["ok": true, "value": NSNull()]) }
    guard status == errSecSuccess,
          let data = result as? Data,
          data.count <= maximumBytes,
          let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { fail() }
    reply(["ok": true, "value": value])
case "set":
    guard let value = request["value"] as? [String: Any],
          let data = try? JSONSerialization.data(withJSONObject: value),
          data.count <= maximumBytes else { fail() }
    let attributes: [String: Any] = [kSecValueData as String: data]
    var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        status = SecItemAdd(item as CFDictionary, nil)
        if status == errSecDuplicateItem {
            status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        }
    }
    guard status == errSecSuccess else { fail() }
    reply(["ok": true])
case "delete":
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { fail() }
    reply(["ok": true])
default:
    fail()
}
