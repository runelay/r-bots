import Foundation

struct SessionStream: Sendable {
    let client: BotsClient
    let basePath: String
    let sessionId: String

    func records(startingAt startIndex: Int) -> AsyncStream<StreamRecord> {
        let client = client
        let basePath = basePath
        let sessionId = sessionId
        return AsyncStream { continuation in
            let task = Task {
                await Self.run(
                    client: client,
                    basePath: basePath,
                    sessionId: sessionId,
                    startIndex: startIndex,
                    continuation: continuation
                )
                continuation.finish()
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    private static func run(
        client: BotsClient,
        basePath: String,
        sessionId: String,
        startIndex: Int,
        continuation: AsyncStream<StreamRecord>.Continuation
    ) async {
        var cursor = startIndex
        var failures = 0

        while !Task.isCancelled {
            var finished = false
            var unavailable = false

            do {
                let request = try client.streamRequest(basePath: basePath, sessionId: sessionId, startIndex: cursor)
                let (bytes, response) = try await URLSession.shared.bytes(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0

                if status == 404 || status == 409 || status == 410 {
                    unavailable = true
                } else if !(200..<300).contains(status) {
                    throw BotsClient.ClientError.http(status, nil)
                } else {
                    continuation.yield(.connected)
                    failures = 0

                    reading: for try await line in bytes.lines {
                        switch StreamLine.parse(line) {
                        case .facts(let facts):
                            cursor += 1
                            continuation.yield(.facts(facts))
                        case .progress(let fact):
                            continuation.yield(.progress(fact))
                        case .leaseEnded:
                            break reading
                        case .streamEnded:
                            finished = true
                            break reading
                        case .heartbeat, .unknown:
                            continue
                        }
                    }
                }
            } catch {
                if Task.isCancelled {
                    return
                }
                failures += 1
                continuation.yield(.reconnecting)
            }

            if unavailable {
                continuation.yield(.unavailable("Esta conversa não está mais disponível no servidor."))
                return
            }
            if finished {
                continuation.yield(.ended)
                return
            }
            if Task.isCancelled {
                return
            }

            let delay = failures == 0 ? 0.2 : min(0.5 * Double(1 << min(failures, 5)), 10)
            do {
                try await Task.sleep(for: .seconds(delay))
            } catch {
                return
            }
        }
    }
}
