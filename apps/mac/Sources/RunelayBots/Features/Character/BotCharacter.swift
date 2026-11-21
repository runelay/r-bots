import SwiftUI

struct BotCharacter: View {
    let botID: String
    var glyph: String?
    let accent: String
    let mood: CharacterMood
    var size: CGFloat = 32

    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var moodStart = Date()
    @State private var isVisible = false

    var body: some View {
        let fullGlyph = CharacterGlyph.forBot(id: botID, glyph: glyph)
        let compactKey =
            glyph.flatMap { CharacterGlyph.compactPreset($0) != nil ? $0 : nil }
            ?? (glyph?.hasPrefix("face-") == true ? "" : botID)
        let resolvedGlyph = size < 18 ? fullGlyph.compacted(for: compactKey) : fullGlyph
        let glows = size >= 24
        let color = Theme.accent(accent)
        let currentMood = mood
        let start = moodStart
        let reduce = reduceMotion
        Group {
            if animates {
                TimelineView(.animation(minimumInterval: frameInterval, paused: !isVisible || !AppActivity.shared.isLive)) { timeline in
                    let time = timeline.date.timeIntervalSinceReferenceDate
                    let age = timeline.date.timeIntervalSince(start)
                    Canvas { context, canvasSize in
                        CharacterRenderer.draw(
                            in: &context,
                            size: canvasSize,
                            glyph: resolvedGlyph,
                            color: color,
                            frame: CharacterFrame(mood: currentMood, time: time, age: age, reduceMotion: reduce, glows: glows)
                        )
                    }
                }
            } else {
                Canvas { context, canvasSize in
                    CharacterRenderer.draw(
                        in: &context,
                        size: canvasSize,
                        glyph: resolvedGlyph,
                        color: color,
                        frame: CharacterFrame(mood: currentMood, time: 1, age: 10, reduceMotion: true, glows: glows)
                    )
                }
            }
        }
        .frame(width: size, height: size)
        .onAppear {
            isVisible = true
        }
        .onDisappear {
            isVisible = false
        }
        .onChange(of: mood) {
            moodStart = Date()
        }
        .accessibilityHidden(true)
    }

    private var animates: Bool {
        guard !reduceMotion else { return false }
        switch mood {
        case .thinking, .speaking: return true
        case .idle, .sleeping, .error, .waiting: return false
        }
    }

    private var frameInterval: Double {
        size > 48 ? 1.0 / 30.0 : 1.0 / 20.0
    }
}

extension BotCharacter {
    init(bot: Bot, mood: CharacterMood, size: CGFloat) {
        self.init(botID: bot.id, glyph: bot.glyph, accent: bot.accent, mood: mood, size: size)
    }
}

struct CharacterFrame: Sendable {
    let mood: CharacterMood
    let time: Double
    let age: Double
    let reduceMotion: Bool
    let glows: Bool
}

enum CharacterRenderer {
    private static let unlitOpacity = 0.09

    static func draw(
        in context: inout GraphicsContext,
        size: CGSize,
        glyph: CharacterGlyph,
        color: Color,
        frame: CharacterFrame
    ) {
        let dimension = glyph.dimension
        let cell = min(size.width, size.height) / CGFloat(dimension)
        let sway = swayOffset(frame)
        let originX = (size.width - cell * CGFloat(dimension)) / 2 + (shakeOffset(frame) + sway.x) * cell
        let originY = (size.height - cell * CGFloat(dimension)) / 2 + sway.y * cell

        if frame.mood == .sleeping {
            drawSleepMarks(in: &context, size: size, color: color, frame: frame)
        }

        for row in 0..<dimension {
            for col in 0..<dimension where glyph.isVisible(row, col) {
                let dot = style(row: row, col: col, glyph: glyph, frame: frame)
                guard dot.opacity > 0.01 else { continue }
                let diameter = cell * 0.78 * CGFloat(dot.scale)
                let centerX = originX + (CGFloat(col) + 0.5) * cell
                let centerY = originY + (CGFloat(row) + 0.5) * cell
                if frame.glows && glyph.isLit(row, col) && dot.opacity > 0.5 {
                    let glow = diameter * 1.55
                    let glowRect = CGRect(x: centerX - glow / 2, y: centerY - glow / 2, width: glow, height: glow)
                    context.fill(Path(ellipseIn: glowRect), with: .color(color.opacity(dot.opacity * 0.12)))
                }
                let rect = CGRect(
                    x: centerX - diameter / 2,
                    y: centerY - diameter / 2,
                    width: diameter,
                    height: diameter
                )
                context.fill(Path(ellipseIn: rect), with: .color(color.opacity(dot.opacity)))
            }
        }
    }

    private static func drawSleepMarks(in context: inout GraphicsContext, size: CGSize, color: Color, frame: CharacterFrame) {
        let side = min(size.width, size.height)
        for index in 0..<2 {
            let phase =
                frame.reduceMotion
                ? 0.5
                : (frame.time / 2.4 + Double(index) * 0.5).truncatingRemainder(dividingBy: 1)
            let opacity = frame.reduceMotion ? 0.55 : sin(phase * .pi) * 0.75
            let fontSize = side * (0.16 + 0.06 * CGFloat(index))
            let point = CGPoint(
                x: side * (0.80 + 0.06 * CGFloat(index)) + CGFloat(phase) * side * 0.04,
                y: side * (0.24 - 0.10 * CGFloat(index)) - CGFloat(phase) * side * 0.10
            )
            let text = Text("z")
                .font(.system(size: fontSize, weight: .bold, design: .rounded))
                .foregroundStyle(color.opacity(opacity))
            context.draw(text, at: point)
        }
    }

    private static func swayOffset(_ frame: CharacterFrame) -> (x: CGFloat, y: CGFloat) {
        guard frame.mood == .thinking, !frame.reduceMotion else { return (0, 0) }
        let x = sin(frame.time * 2 * .pi / 1.6) * 0.55
        let y = abs(sin(frame.time * 2 * .pi / 0.8)) * -0.35
        return (CGFloat(x), CGFloat(y))
    }

    private static func shakeOffset(_ frame: CharacterFrame) -> CGFloat {
        guard frame.mood == .error, !frame.reduceMotion, frame.age < 0.6 else { return 0 }
        let decay = 1 - frame.age / 0.6
        return CGFloat(sin(frame.age * 46) * decay * 0.55)
    }

    private static func style(row: Int, col: Int, glyph: CharacterGlyph, frame: CharacterFrame) -> (opacity: Double, scale: Double) {
        let lit = glyph.isLit(row, col)
        let time = frame.time
        let center = Double(glyph.dimension - 1) / 2

        switch frame.mood {
        case .idle:
            if lit && isBlinking(row: row, glyph: glyph, frame: frame) {
                return (unlitOpacity + 0.08, 1)
            }
            let breath = 0.5 + 0.5 * sin(time * 2 * .pi / 4.2)
            return lit ? (0.86 + 0.14 * breath, 1) : (unlitOpacity, 1)

        case .thinking:
            if frame.reduceMotion {
                let pulse = 0.5 + 0.5 * sin(time * 2)
                return lit ? (0.7 + 0.3 * pulse, 1) : (unlitOpacity, 1)
            }
            let wave = sin(Double(row + col) * 0.75 - time * 5.5)
            let level = 0.5 + 0.5 * wave
            if lit {
                return (0.62 + 0.38 * level, 0.86 + 0.2 * level)
            }
            return (unlitOpacity + 0.2 * max(0, wave), 0.9 + 0.1 * level)

        case .speaking:
            let dy = Double(row - glyph.mouthRow)
            let dx = Double(col) - center
            let distance = (dx * dx + dy * dy).squareRoot()
            let wave = 0.5 + 0.5 * sin(distance * 1.4 - time * 9)
            if frame.reduceMotion {
                return lit ? (0.78 + 0.22 * wave, 1) : (unlitOpacity, 1)
            }
            if lit {
                return (0.78 + 0.22 * wave, 0.84 + 0.28 * wave)
            }
            let near = max(0, 1 - distance / 3.5)
            return (unlitOpacity + 0.2 * wave * near, 1)

        case .waiting:
            let pulse = 0.5 + 0.5 * sin(time * 2 * .pi / 1.3)
            if frame.reduceMotion {
                return lit ? (0.7 + 0.3 * pulse, 1) : (unlitOpacity, 1)
            }
            return lit ? (0.72 + 0.28 * pulse, 0.92 + 0.12 * pulse) : (unlitOpacity + 0.05 * pulse, 1)

        case .error:
            if frame.age < 0.6 && !frame.reduceMotion {
                return lit ? (1, 1) : (unlitOpacity, 1)
            }
            return lit ? (0.6, 1) : (unlitOpacity * 0.8, 1)

        case .sleeping:
            if lit && glyph.eyeRows.contains(row) && row != glyph.eyeRows.last {
                return (unlitOpacity, 1)
            }
            let breath = 0.5 + 0.5 * sin(time * 2 * .pi / 5.5)
            return lit ? (0.42 + 0.12 * breath, 1) : (unlitOpacity * 0.7, 1)
        }
    }

    private static func isBlinking(row: Int, glyph: CharacterGlyph, frame: CharacterFrame) -> Bool {
        guard !frame.reduceMotion, glyph.eyeRows.contains(row), row != glyph.eyeRows.last else { return false }
        return frame.time.truncatingRemainder(dividingBy: 5.3) < 0.16
    }
}

struct GroupAvatar: View {
    let members: [Bot]
    var size: CGFloat = 40

    var body: some View {
        let shown = Array(members.prefix(3))
        let item = size * (shown.count >= 3 ? 0.56 : 0.64)
        ZStack {
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, member in
                BotCharacter(bot: member, mood: .idle, size: item)
                    .padding(1.5)
                    .background(Theme.surfaceRaised, in: Circle())
                    .offset(offset(index: index, count: shown.count, item: item))
            }
            if shown.isEmpty {
                Image(systemName: "person.3")
                    .font(.system(size: size * 0.4))
                    .foregroundStyle(Theme.textTertiary)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func offset(index: Int, count: Int, item: CGFloat) -> CGSize {
        let spread = (size - item) / 2
        switch (count, index) {
        case (2, 0): return CGSize(width: -spread, height: -spread * 0.6)
        case (2, _): return CGSize(width: spread, height: spread * 0.6)
        case (3, 0): return CGSize(width: 0, height: -spread)
        case (3, 1): return CGSize(width: -spread, height: spread * 0.8)
        case (3, _): return CGSize(width: spread, height: spread * 0.8)
        default: return .zero
        }
    }
}
