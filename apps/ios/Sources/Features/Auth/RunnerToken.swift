import Foundation

enum RunnerToken {
    static func read() -> String? {
        AuthStore.read(.session)
    }
}
