import SwiftUI

extension EnvironmentValues {
    @Entry var markdownOnAccent = false
    @Entry var transcriptToggle: (String, Bool) -> Void = { _, _ in }
}

@MainActor
@Observable
final class MessageFolds {
    static let shared = MessageFolds()
    private(set) var expanded: Set<String> = []

    func isExpanded(_ key: String) -> Bool {
        expanded.contains(key)
    }

    func set(_ key: String, expanded value: Bool) {
        if value {
            expanded.insert(key)
        } else {
            expanded.remove(key)
        }
    }
}

struct MessageFoldPlan: Equatable {
    let head: String
    let tail: String?
    let hiddenLines: Int
}

@MainActor
enum MessageFolding {
    private static var cache: [Int: MessageFoldPlan?] = [:]
    static let maxLines = 14
    static let maxCharacters = 1400
    private static let headLines = 8
    private static let headCharacters = 700
    private static let tailLines = 3
    private static let tailCharacters = 320

    static func plan(_ text: String, keepsTail: Bool) -> MessageFoldPlan? {
        var hasher = Hasher()
        hasher.combine(text)
        hasher.combine(keepsTail)
        let key = hasher.finalize()
        if let hit = cache[key] {
            return hit
        }
        let value = compute(text, keepsTail: keepsTail)
        if cache.count > 600 {
            cache.removeAll(keepingCapacity: true)
        }
        cache[key] = value
        return value
    }

    private static func compute(_ text: String, keepsTail: Bool) -> MessageFoldPlan? {
        let lines = text.components(separatedBy: "\n")
        guard lines.count > maxLines || text.count > maxCharacters else { return nil }
        var tailStart = lines.count
        var tail: [String] = []
        if keepsTail {
            var characters = 0
            var index = lines.count - 1
            while index >= 0, tail.filter({ !$0.trimmingCharacters(in: .whitespaces).isEmpty }).count < tailLines {
                let line = lines[index]
                if characters + line.count > tailCharacters, !tail.isEmpty { break }
                characters += line.count
                tail.insert(line, at: 0)
                index -= 1
            }
            tailStart = index + 1
            while let first = tail.first, first.trimmingCharacters(in: .whitespaces).isEmpty {
                tail.removeFirst()
            }
        }
        var head: [String] = []
        var characters = 0
        for line in lines[0..<tailStart] {
            if head.count >= headLines { break }
            if characters + line.count > headCharacters {
                let room = max(0, headCharacters - characters)
                if room > 40 || head.isEmpty {
                    let cut = String(line.prefix(max(room, 200)))
                    let trimmed = cut.lastIndex(of: " ").map { String(cut[..<$0]) } ?? cut
                    head.append(trimmed + "…")
                }
                break
            }
            head.append(line)
            characters += line.count + 1
        }
        while let last = head.last, last.trimmingCharacters(in: .whitespaces).isEmpty {
            head.removeLast()
        }
        let hidden = max(0, tailStart - head.count)
        if keepsTail, hidden < 2 {
            return MessageFoldPlan(head: balance(head), tail: nil, hiddenLines: max(0, lines.count - head.count))
        }
        let headFences = fences(head)
        var headText = head
        if headFences % 2 == 1 {
            headText.append("```")
        }
        var tailText: String?
        if keepsTail, !tail.isEmpty {
            let before = fences(Array(lines[0..<tailStart]))
            tailText = (before % 2 == 1 ? "```\n" : "") + tail.joined(separator: "\n")
        }
        return MessageFoldPlan(head: headText.joined(separator: "\n"), tail: tailText, hiddenLines: keepsTail ? hidden : lines.count - head.count)
    }

    private static func balance(_ lines: [String]) -> String {
        (fences(lines) % 2 == 1 ? lines + ["```"] : lines).joined(separator: "\n")
    }

    private static func fences(_ lines: [String]) -> Int {
        lines.filter { $0.trimmingCharacters(in: .whitespaces).hasPrefix("```") }.count
    }
}

struct FoldedMarkdown: View {
    @Environment(\.appReduceMotion) private var reduceMotion
    let text: String
    let plan: MessageFoldPlan?
    let expanded: Bool
    let fontSize: CGFloat
    let bubble: Color
    let expand: () -> Void

    var body: some View {
        if let plan, !expanded {
            VStack(alignment: .leading, spacing: Spacing.s) {
                MarkdownView(text: plan.head, fontSize: fontSize)
                    .overlay(alignment: .bottom) {
                        if plan.tail == nil {
                            fade
                        }
                    }
                if let tail = plan.tail {
                    Button(action: expand) {
                        HStack(spacing: Spacing.s) {
                            Capsule().fill(.foreground.opacity(0.25)).frame(height: 1)
                            Text("\(plan.hiddenLines) linha\(plan.hiddenLines == 1 ? "" : "s")")
                                .font(TypeScale.captionStrong)
                                .fixedSize()
                            Capsule().fill(.foreground.opacity(0.25)).frame(height: 1)
                        }
                        .opacity(0.75)
                        .frame(height: 18)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .clickable()
                    .help("Mostrar a mensagem inteira")
                    MarkdownView(text: tail, fontSize: fontSize)
                }
            }
            .transition(.opacity)
        } else {
            MarkdownView(text: text, fontSize: fontSize)
                .transition(.opacity)
        }
    }

    private var fade: some View {
        LinearGradient(colors: [bubble.opacity(0), bubble], startPoint: .top, endPoint: .bottom)
            .frame(height: 36)
            .allowsHitTesting(false)
    }
}

struct MessageFoldRef: Equatable {
    let key: String
    let row: String
}

struct FoldToggle: View {
    let expanded: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: Spacing.xs) {
                Text(expanded ? "Ver menos" : "Ver mais")
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .bold))
                    .rotationEffect(.degrees(expanded ? 180 : 0))
            }
            .font(TypeScale.captionStrong)
            .foregroundStyle(hovering ? Theme.textPrimary : Theme.textSecondary)
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .onHover { hovering = $0 }
    }
}
