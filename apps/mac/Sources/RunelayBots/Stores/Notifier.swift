import AppKit
import Foundation
import SwiftUI
import UserNotifications

enum NotificationPreference: String, CaseIterable, Identifiable {
    case replies
    case approvals
    case routines
    case failures

    var id: String { rawValue }

    var key: String { "notify.\(rawValue)" }

    var title: String {
        switch self {
        case .replies: tr("Respostas dos bots")
        case .approvals: tr("Aprovações pendentes")
        case .routines: tr("Resultados de rotinas")
        case .failures: tr("Turnos com erro")
        }
    }

    var detail: String {
        switch self {
        case .replies: tr("Quando um bot ou grupo responde e a conversa não está na tela.")
        case .approvals: tr("Com os botões Aprovar e Negar direto na notificação.")
        case .routines: tr("Só as rotinas que pedem sua atenção.")
        case .failures: tr("Quando um turno termina com erro.")
        }
    }

    var isEnabled: Bool {
        UserDefaults.standard.object(forKey: key) as? Bool ?? true
    }
}

@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()

    private weak var model: AppModel?
    private var configured = false
    private var delivered: [String: Date] = [:]

    var isAvailable: Bool {
        Bundle.main.bundleIdentifier != nil && Bundle.main.bundleURL.pathExtension == "app"
    }

    func setUp(model: AppModel) {
        self.model = model
        guard isAvailable, !configured else { return }
        configured = true
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let approve = UNNotificationAction(identifier: "approve", title: tr("Aprovar"), options: [])
        let deny = UNNotificationAction(identifier: "deny", title: tr("Negar"), options: [.destructive])
        let approval = UNNotificationCategory(identifier: "approval", actions: [approve, deny], intentIdentifiers: [], options: [])
        center.setNotificationCategories([approval])
        Task {
            _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        }
    }

    func post(_ event: StoreNotification, bot: Bot, speakerName: String?) {
        guard isAvailable else { return }
        let content = UNMutableNotificationContent()
        var info: [String: String] = ["botID": bot.id]
        switch event {
        case .reply(let text, _, let schedule):
            let preference: NotificationPreference = schedule ? .routines : .replies
            guard preference.isEnabled else { return }
            content.title = schedule ? tr("%@ · Rotina", bot.name) : bot.name
            content.body = speakerName.map { "\($0): \(text)" } ?? text
        case .approval(let id, let prompt):
            guard NotificationPreference.approvals.isEnabled else { return }
            content.title = tr("%@ precisa de você", bot.name)
            content.body = prompt.isEmpty ? tr("Uma ação está esperando sua aprovação.") : prompt
            content.categoryIdentifier = "approval"
            info["interactionID"] = id
        case .question(_, let title, let sessionID):
            guard NotificationPreference.approvals.isEnabled else { return }
            content.title = tr("%@ quer saber", bot.name)
            content.body = title.isEmpty ? tr("Uma pergunta está esperando sua resposta.") : title
            if let sessionID {
                info["sessionID"] = sessionID
            }
        case .failed(let message):
            guard NotificationPreference.failures.isEnabled else { return }
            content.title = tr("%@ parou com erro", bot.name)
            content.body = message
        case .ciFailed(let number, let check):
            guard NotificationPreference.failures.isEnabled else { return }
            content.title = tr("CI falhou · PR #%lld", number)
            content.body = "\(bot.name) · \(check)"
        }
        content.userInfo = info
        content.sound = .default
        content.threadIdentifier = bot.id
        if !bot.role.trimmingCharacters(in: .whitespaces).isEmpty, bot.role.count <= 40 {
            content.subtitle = bot.role
        }
        if let attachment = Self.avatarAttachment(for: bot) {
            content.attachments = [attachment]
        }
        let identifier = Self.identifier(for: event, botID: bot.id)
        let now = Date()
        delivered = delivered.filter { now.timeIntervalSince($0.value) < 86_400 }
        guard delivered[identifier] == nil else { return }
        delivered[identifier] = now
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
        Task {
            try? await UNUserNotificationCenter.current().add(request)
        }
    }

    static func identifier(for event: StoreNotification, botID: String) -> String {
        switch event {
        case .reply(let text, let speakerID, _):
            "reply-\(botID)-\(speakerID ?? "")-\(fingerprint(text))"
        case .approval(let id, _):
            "approval-\(botID)-\(id)"
        case .question(let id, _, _):
            "question-\(botID)-\(id)"
        case .failed(let message):
            "failed-\(botID)-\(fingerprint(message))"
        case .ciFailed(let number, let check):
            "ci-\(botID)-\(number)-\(fingerprint(check))"
        }
    }

    private static func fingerprint(_ text: String) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in text.utf8 {
            hash = (hash ^ UInt64(byte)) &* 0x100_0000_01b3
        }
        return String(hash, radix: 16)
    }

    private static func avatarAttachment(for bot: Bot) -> UNNotificationAttachment? {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("runelay-avatars", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent("\(bot.id)-\(UUID().uuidString).png")
        let glyph = CharacterGlyph.forBot(id: bot.id, glyph: bot.glyph)
        let color = Theme.accent(bot.accent)
        let avatar = ZStack {
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(Color(red: 0.09, green: 0.09, blue: 0.1))
            Canvas { context, size in
                CharacterRenderer.draw(
                    in: &context,
                    size: size,
                    glyph: glyph,
                    color: color,
                    frame: CharacterFrame(mood: .idle, time: 0, age: 0, reduceMotion: true, glows: true)
                )
            }
            .padding(22)
        }
        .frame(width: 128, height: 128)
        .environment(\.colorScheme, .dark)
        let renderer = ImageRenderer(content: avatar)
        renderer.scale = 2
        guard let image = renderer.nsImage,
            let tiff = image.tiffRepresentation,
            let bitmap = NSBitmapImageRep(data: tiff),
            let png = bitmap.representation(using: .png, properties: [:]),
            (try? png.write(to: url)) != nil
        else { return nil }
        return try? UNNotificationAttachment(identifier: "avatar", url: url, options: nil)
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        let botID = info["botID"] as? String
        let interactionID = info["interactionID"] as? String
        let sessionID = info["sessionID"] as? String
        let action = response.actionIdentifier
        let usage = info["usage"] != nil
        Task { @MainActor in
            if usage {
                Notifier.shared.openUsage()
                return
            }
            Notifier.shared.handle(botID: botID, interactionID: interactionID, sessionID: sessionID, action: action)
        }
        completionHandler()
    }

    private func openUsage() {
        guard let model else { return }
        model.closeSettings()
        model.section = .usage
        NSApp.activate()
    }

    private func handle(botID: String?, interactionID: String?, sessionID: String?, action: String) {
        guard let model, let botID else { return }
        if let interactionID, action == "approve" || action == "deny" {
            model.answerFromNotification(botID: botID, interactionID: interactionID, optionID: action)
            return
        }
        model.openConversation(botID, sessionID: sessionID)
        NSApp.activate()
    }
}
