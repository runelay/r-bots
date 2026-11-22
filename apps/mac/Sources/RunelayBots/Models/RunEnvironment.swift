import Foundation

struct RunEnvironment: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let label: String
    let online: Bool
    let canRun: Bool

    var isMac: Bool {
        id == "mac"
    }

    var symbol: String {
        isMac ? "laptopcomputer" : "server.rack"
    }
}

struct RunEnvironments: Decodable, Equatable, Sendable {
    var selected: String
    var environments: [RunEnvironment]

    var current: RunEnvironment? {
        environments.first { $0.id == selected }
    }

    var currentOnline: Bool {
        current?.online ?? false
    }
}
