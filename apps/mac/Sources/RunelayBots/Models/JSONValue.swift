import Foundation

enum JSONValue: Sendable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])
}

extension JSONValue: Codable {
    init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            self = .null
        }
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case .bool(let value):
            try container.encode(value)
        case .number(let value):
            try container.encode(value)
        case .string(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        }
    }
}

extension JSONValue {
    static func parse(_ text: String) -> JSONValue? {
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: data)
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let object) = self {
            return object[key]
        }
        return nil
    }

    var stringValue: String? {
        if case .string(let value) = self {
            return value
        }
        return nil
    }

    var doubleValue: Double? {
        if case .number(let value) = self {
            return value
        }
        return nil
    }

    var intValue: Int? {
        guard let value = doubleValue, value.isFinite, abs(value) < 9_000_000_000_000_000 else { return nil }
        return Int(value)
    }

    var boolValue: Bool? {
        if case .bool(let value) = self {
            return value
        }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case .array(let value) = self {
            return value
        }
        return nil
    }

    var objectValue: [String: JSONValue]? {
        if case .object(let value) = self {
            return value
        }
        return nil
    }

    var isNull: Bool {
        if case .null = self {
            return true
        }
        return false
    }

    var inlineDescription: String? {
        switch self {
        case .null:
            return nil
        case .bool(let value):
            return value ? "sim" : "não"
        case .number(let value):
            return JSONValue.format(value)
        case .string(let value):
            let collapsed =
                value
                .replacingOccurrences(of: "\n", with: " ")
                .trimmingCharacters(in: .whitespaces)
            return collapsed.count > 140 ? String(collapsed.prefix(140)) + "…" : collapsed
        case .array(let value):
            return value.count == 1 ? "1 item" : "\(value.count) itens"
        case .object(let value):
            return value.isEmpty ? nil : "{…}"
        }
    }

    func prettyPrinted(limit: Int = 6_000) -> String {
        let text: String
        if case .string(let value) = self {
            text = value
        } else {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            if let data = try? encoder.encode(self), let encoded = String(data: data, encoding: .utf8) {
                text = encoded
            } else {
                text = ""
            }
        }
        return text.count > limit ? String(text.prefix(limit)) + "\n…" : text
    }

    private static func format(_ value: Double) -> String {
        if value.isFinite, value == value.rounded(), abs(value) < 1_000_000_000_000_000 {
            return String(Int(value))
        }
        return String(value)
    }
}
