import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@main
struct RBotsWidgets: WidgetBundle {
    var body: some Widget {
        BotLiveActivity()
    }
}

struct BotLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: BotActivityAttributes.self) { context in
            LockScreenActivity(attributes: context.attributes, state: context.state)
                .activityBackgroundTint(Color.black.opacity(0.82))
                .activitySystemActionForegroundColor(.white)
                .widgetURL(context.attributes.url)
        } dynamicIsland: { context in
            let attributes = context.attributes
            let state = context.state
            let accent = BotTint.color(attributes.accent)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    BotMark(accent: accent, phase: state.phase, size: 40)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    PhaseBadge(state: state, accent: accent)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(attributes.botName)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Text(state.headline)
                            .font(.subheadline.weight(.medium))
                            .lineLimit(2)
                            .contentTransition(.opacity)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    ActivityActions(attributes: attributes, state: state, accent: accent)
                        .padding(.top, 4)
                }
            } compactLeading: {
                BotMark(accent: accent, phase: state.phase, size: 22)
            } compactTrailing: {
                CompactStatus(state: state, accent: accent)
            } minimal: {
                BotMark(accent: accent, phase: state.phase, size: 22)
            }
            .widgetURL(attributes.url)
            .keylineTint(accent)
        }
    }
}

// MARK: - Tela bloqueada

private struct LockScreenActivity: View {
    let attributes: BotActivityAttributes
    let state: BotActivityAttributes.ContentState

    var body: some View {
        let accent = BotTint.color(attributes.accent)
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 12) {
                BotMark(accent: accent, phase: state.phase, size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(attributes.botName)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.6))
                    Text(state.headline)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.white)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                PhaseBadge(state: state, accent: accent)
            }
            ActivityActions(attributes: attributes, state: state, accent: accent)
        }
        .padding(16)
    }
}

// MARK: - Peças

private struct BotMark: View {
    let accent: Color
    let phase: BotActivityAttributes.Phase
    let size: CGFloat

    var body: some View {
        let eyeHeight: CGFloat =
            switch phase {
            case .done: size * 0.08
            case .approval, .question: size * 0.28
            default: size * 0.22
            }
        RoundedRectangle(cornerRadius: size * 0.32, style: .continuous)
            .fill(accent)
            .frame(width: size, height: size)
            .overlay {
                HStack(spacing: size * 0.18) {
                    Capsule().frame(width: size * 0.12, height: eyeHeight)
                    Capsule().frame(width: size * 0.12, height: eyeHeight)
                }
                .foregroundStyle(Color.black.opacity(0.85))
                .offset(x: phase == .working ? size * 0.06 : 0, y: phase == .failed ? size * 0.06 : 0)
            }
            .animation(.spring(duration: 0.4), value: phase)
            .accessibilityHidden(true)
    }
}

private struct CompactStatus: View {
    let state: BotActivityAttributes.ContentState
    let accent: Color

    var body: some View {
        switch state.phase {
        case .working:
            Text(timerInterval: state.startedAt...Date.distantFuture, countsDown: false)
                .font(.caption2.monospacedDigit().weight(.semibold))
                .foregroundStyle(accent)
                .frame(maxWidth: 44)
                .multilineTextAlignment(.trailing)
        case .approval:
            Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
        case .question:
            Image(systemName: "questionmark.bubble.fill").foregroundStyle(accent)
        case .done:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
        }
    }
}

private struct PhaseBadge: View {
    let state: BotActivityAttributes.ContentState
    let accent: Color

    var body: some View {
        switch state.phase {
        case .working:
            VStack(alignment: .trailing, spacing: 2) {
                Text("Rodando")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(accent)
                Text(timerInterval: state.startedAt...Date.distantFuture, countsDown: false)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: 56)
            }
        case .approval:
            Label("Permissão", systemImage: "hand.raised.fill")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.orange)
        case .question:
            Label("Pergunta", systemImage: "questionmark.bubble.fill")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(accent)
        case .done:
            Label("Pronto", systemImage: "checkmark.circle.fill")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.green)
        case .failed:
            Label("Falhou", systemImage: "exclamationmark.triangle.fill")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.red)
        }
    }
}

private struct ActivityActions: View {
    let attributes: BotActivityAttributes
    let state: BotActivityAttributes.ContentState
    let accent: Color

    var body: some View {
        if let answering = state.answering {
            Text(answering)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else if let interactionID = state.interactionID, !state.choices.isEmpty {
            HStack(spacing: 8) {
                ForEach(Array(state.choices.enumerated()), id: \.element.id) { index, choice in
                    Button(
                        intent: AnswerBotActivityIntent(
                            attributes: attributes,
                            interactionID: interactionID,
                            optionID: choice.id,
                            questionID: state.questionID
                        )
                    ) {
                        Text(choice.label)
                            .font(.caption.weight(.semibold))
                            .lineLimit(1)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(tint(for: choice, index: index))
                }
            }
        } else if state.phase == .approval || state.phase == .question {
            Link(destination: attributes.url) {
                Text("Abrir no app para responder")
                    .font(.caption.weight(.semibold))
                    .frame(maxWidth: .infinity)
            }
        }
    }

    private func tint(for choice: BotActivityAttributes.Choice, index: Int) -> Color {
        switch choice.id {
        case "deny": .gray.opacity(0.5)
        case "approve", "approve_always": accent
        default: index == 0 ? accent : .gray.opacity(0.5)
        }
    }
}

enum BotTint {
    static func color(_ accent: String) -> Color {
        switch accent {
        case "white": Color(white: 0.94)
        case "amber": Color(red: 1.0, green: 0.75, blue: 0.2)
        case "red": Color(red: 1.0, green: 0.36, blue: 0.36)
        case "orange": Color(red: 1.0, green: 0.55, blue: 0.2)
        case "yellow": Color(red: 1.0, green: 0.86, blue: 0.3)
        case "green": Color(red: 0.3, green: 0.85, blue: 0.5)
        case "teal": Color(red: 0.25, green: 0.8, blue: 0.78)
        case "blue": Color(red: 0.35, green: 0.6, blue: 1.0)
        case "violet": Color(red: 0.65, green: 0.5, blue: 1.0)
        case "pink": Color(red: 1.0, green: 0.45, blue: 0.75)
        case "grey": Color(white: 0.62)
        default: Color(red: 0.42, green: 0.55, blue: 1.0)
        }
    }
}
