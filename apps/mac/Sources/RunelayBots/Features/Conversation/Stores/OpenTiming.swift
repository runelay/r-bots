import Foundation
import os

@MainActor
enum OpenTiming {
    static let enabled = UserDefaults.standard.bool(forKey: "debugOpenTiming")
    private static let log = OSLog(subsystem: "com.runelay.bots", category: "ConversationOpen")
    private static var pending: [String: (start: Date, label: String, signpost: OSSignpostID)] = [:]
    private static var launchReported = false

    private static var processStart: Date {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return Date() }
        let start = info.kp_proc.p_un.__p_starttime
        return Date(timeIntervalSince1970: Double(start.tv_sec) + Double(start.tv_usec) / 1_000_000)
    }

    static func begin(_ sessionID: String?, label: String) {
        guard enabled, let sessionID else { return }
        let signpost = OSSignpostID(log: log)
        os_signpost(.begin, log: log, name: "open", signpostID: signpost, "%{public}s", label)
        pending[sessionID] = (Date(), label, signpost)
    }

    static func shown(_ sessionID: String?, source: String) {
        guard enabled, let sessionID else { return }
        let entry: (start: Date, label: String, signpost: OSSignpostID)
        if let found = pending.removeValue(forKey: sessionID) {
            entry = found
        } else if !launchReported {
            launchReported = true
            entry = (processStart, "launch", OSSignpostID(log: log))
        } else {
            return
        }
        DispatchQueue.main.async {
            let ms = Date().timeIntervalSince(entry.start) * 1000
            os_signpost(.end, log: log, name: "open", signpostID: entry.signpost, "%{public}s", source)
            write("\(entry.label) \(sessionID.suffix(6)) \(source) \(String(format: "%.1f", ms))ms")
        }
    }

    static func note(_ text: String) {
        guard enabled else { return }
        write(text)
    }

    private static func write(_ line: String) {
        guard
            let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
                .appending(path: "runelay bots", directoryHint: .isDirectory)
        else { return }
        let url = folder.appending(path: "open-timing.log")
        let data = Data("\(ISO8601DateFormatter().string(from: Date())) \(line)\n".utf8)
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try? data.write(to: url)
        }
    }
}

@MainActor
enum OpenBench {
    static func runIfRequested(_ model: AppModel) {
        guard OpenTiming.enabled, UserDefaults.standard.bool(forKey: "debugOpenBench") else { return }
        Task {
            try? await Task.sleep(for: .seconds(4))
            let bots = model.loadedBots.filter { !$0.isPending && $0.thread?.sessionId != nil }.prefix(5)
            for round in ["cold", "warm"] {
                for bot in bots {
                    OpenTiming.begin(model.conversation(for: bot.id)?.sessionId ?? bot.thread?.sessionId, label: "bot-\(round)")
                    model.openConversation(bot.id)
                    try? await Task.sleep(for: .seconds(1.5))
                }
            }
            for bot in bots {
                let others = model.conversations(for: bot.id).filter { $0.sessionId != model.conversation(for: bot.id)?.sessionId }.prefix(2)
                for conversation in others {
                    OpenTiming.begin(conversation.sessionId, label: "older")
                    model.selectConversation(botID: bot.id, sessionID: conversation.sessionId)
                    try? await Task.sleep(for: .seconds(1.5))
                }
            }
            OpenTiming.note("bench done")
        }
    }
}
