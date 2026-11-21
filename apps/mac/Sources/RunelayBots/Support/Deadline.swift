import Foundation

enum Deadline {
    struct Exceeded: LocalizedError, Equatable {
        var errorDescription: String? { "O servidor não respondeu a tempo." }
    }

    static func run<Value: Sendable>(
        seconds: Double,
        _ operation: @escaping @Sendable () async throws -> Value
    ) async throws -> Value {
        try await withThrowingTaskGroup(of: Value.self) { group in
            group.addTask {
                try await operation()
            }
            group.addTask {
                try await Task.sleep(for: .seconds(seconds))
                throw Exceeded()
            }
            defer { group.cancelAll() }
            guard let value = try await group.next() else {
                throw Exceeded()
            }
            return value
        }
    }
}
