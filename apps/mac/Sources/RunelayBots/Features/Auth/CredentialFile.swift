import CryptoKit
import Foundation
import IOKit
import os
import Security

struct CredentialBook: Codable, Sendable {
    var tokens: [String: String] = [:]
    var settled: Set<String> = []
}

enum CredentialFile {
    static let logger = Logger(subsystem: "runelay.bots", category: "credentials")

    static var url: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Application Support/runelay bots/credentials.bin")
    }

    private struct Envelope: Codable {
        var version: Int
        var salt: Data
        var box: Data
    }

    private static let info = Data("runelay bots credentials v1".utf8)

    static func load() -> CredentialBook {
        guard let raw = try? Data(contentsOf: url) else { return CredentialBook() }
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: raw),
              let key = key(salt: envelope.salt),
              let sealed = try? AES.GCM.SealedBox(combined: envelope.box),
              let plain = try? AES.GCM.open(sealed, using: key),
              let book = try? JSONDecoder().decode(CredentialBook.self, from: plain)
        else {
            logger.error("credentials file unreadable, starting empty")
            return CredentialBook()
        }
        return book
    }

    @discardableResult
    static func save(_ book: CredentialBook) -> Bool {
        let salt = Data((0..<16).map { _ in UInt8.random(in: 0...255) })
        guard let key = key(salt: salt),
              let plain = try? JSONEncoder().encode(book),
              let box = try? AES.GCM.seal(plain, using: key).combined,
              let data = try? JSONEncoder().encode(Envelope(version: 1, salt: salt, box: box))
        else { return false }
        let manager = FileManager.default
        let folder = url.deletingLastPathComponent()
        try? manager.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let temp = folder.appending(path: ".credentials-\(UUID().uuidString).tmp")
        guard manager.createFile(atPath: temp.path(percentEncoded: false), contents: data, attributes: [.posixPermissions: 0o600]) else {
            return false
        }
        guard rename(temp.path(percentEncoded: false), url.path(percentEncoded: false)) == 0 else {
            try? manager.removeItem(at: temp)
            return false
        }
        var target = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? target.setResourceValues(values)
        return true
    }

    private static func key(salt: Data) -> SymmetricKey? {
        guard let machine = platformUUID() else { return nil }
        return HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: Data(machine.utf8)),
            salt: salt,
            info: info,
            outputByteCount: 32
        )
    }

    private static func platformUUID() -> String? {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"))
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }
        let value = IORegistryEntryCreateCFProperty(service, "IOPlatformUUID" as CFString, kCFAllocatorDefault, 0)
        return value?.takeRetainedValue() as? String
    }
}

enum LegacyAuthKeychain {
    static let service = "com.runelay.bots.auth"

    static func exists(account: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        return SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess
    }

    static func readOnce(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        CredentialFile.logger.notice("legacy keychain read status=\(status, privacy: .public)")
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    static func purge(account: String) {
        DispatchQueue.global(qos: .utility).async {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
            process.arguments = ["delete-generic-password", "-s", service, "-a", account]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            do {
                try process.run()
                process.waitUntilExit()
                CredentialFile.logger.notice("legacy keychain item removed exit=\(process.terminationStatus, privacy: .public)")
            } catch {
                CredentialFile.logger.error("legacy keychain removal failed to start")
            }
        }
    }
}
