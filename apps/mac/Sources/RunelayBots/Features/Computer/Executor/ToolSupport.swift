import Foundation

struct ToolFailure: Error, Sendable {
    let status: Int
    let code: String
    let message: String

    init(_ status: Int = 400, code: String, _ message: String) {
        self.status = status
        self.code = code
        self.message = message
    }

    static func badArgs(_ message: String) -> ToolFailure {
        ToolFailure(400, code: "bad_args", message)
    }

    static let stopped = ToolFailure(409, code: "stopped", "A pessoa apertou Parar.")
    static let userBusy = ToolFailure(409, code: "user_busy", "A pessoa está usando o Mac agora (clicando, rolando ou digitando) e não parou em 15 s. Nada foi feito. Espere um pouco, tire um print novo e tente de novo. Não é falta de permissão.")

    static func userInterrupted(typed: Int, total: Int) -> ToolFailure {
        ToolFailure(409, code: "user_interrupted", "A pessoa clicou ou digitou enquanto eu digitava e parei para não escrever no lugar errado: saíram \(typed) de \(total) caracteres. Tire um print, confira o campo em foco e digite só o que faltou.")
    }

    static func missing(_ permission: ComputerPermission) -> ToolFailure {
        ToolFailure(403, code: "permission_denied", "O macOS não liberou \(permission.title) para o r/bots, então a ação não aconteceu. Abri Ajustes do Sistema → Privacidade e Segurança → \(permission.title) no Mac: a pessoa precisa ligar o r/bots ali (se já estiver ligado, desligar e ligar de novo) e depois você tenta outra vez.")
    }

    var json: JSONValue {
        .object(["ok": .bool(false), "code": .string(code), "error": .string(message)])
    }
}

struct ExecutorCall: Sendable {
    let tool: String
    let args: [String: JSONValue]
    let botId: String
    let botName: String
    let sessionId: String
    let allowedRoots: [String]

    init(tool: String, body: Data) throws {
        let parsed = try? JSONDecoder().decode(JSONValue.self, from: body.isEmpty ? Data("{}".utf8) : body)
        guard let root = parsed?.objectValue else { throw ToolFailure.badArgs("Corpo do pedido não é um JSON válido.") }
        let context = root["context"]?.objectValue ?? [:]
        self.tool = tool
        self.args = root["args"]?.objectValue ?? [:]
        self.botId = context["botId"]?.stringValue ?? "bot"
        self.botName = context["botName"]?.stringValue ?? context["botId"]?.stringValue ?? "Bot"
        self.sessionId = context["sessionId"]?.stringValue ?? "default"
        self.allowedRoots = context["allowedRoots"]?.arrayValue?.compactMap(\.stringValue) ?? ["~/Desktop", "~/Downloads", "~/Documents"]
    }

    func string(_ key: String) -> String? {
        guard let value = args[key]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }

    func rawString(_ key: String) -> String? {
        args[key]?.stringValue
    }

    func requiredString(_ key: String) throws -> String {
        guard let value = string(key) else { throw ToolFailure.badArgs("Falta o campo \"\(key)\".") }
        return value
    }

    func number(_ key: String) -> Double? {
        args[key]?.doubleValue
    }

    func requiredNumber(_ key: String) throws -> Double {
        guard let value = number(key) else { throw ToolFailure.badArgs("Falta o campo numérico \"\(key)\".") }
        return value
    }

    func bool(_ key: String) -> Bool {
        args[key]?.boolValue ?? false
    }

    func rect(_ key: String) throws -> CGRect? {
        guard let object = args[key]?.objectValue else { return nil }
        guard let x = object["x"]?.doubleValue, let y = object["y"]?.doubleValue,
              let width = object["width"]?.doubleValue, let height = object["height"]?.doubleValue,
              width >= 1, height >= 1 else {
            throw ToolFailure.badArgs("\"\(key)\" precisa de x, y, width e height.")
        }
        return CGRect(x: x, y: y, width: width, height: height)
    }

    func strings(_ key: String) -> [String] {
        args[key]?.arrayValue?.compactMap(\.stringValue) ?? []
    }
}

extension JSONValue {
    static func int(_ value: Int) -> JSONValue {
        .number(Double(value))
    }

    static func point(_ value: CGFloat) -> JSONValue {
        .number(Double(value).rounded())
    }

    static func frame(_ rect: CGRect) -> JSONValue {
        .object([
            "x": .point(rect.minX),
            "y": .point(rect.minY),
            "width": .point(rect.width),
            "height": .point(rect.height),
        ])
    }
}
