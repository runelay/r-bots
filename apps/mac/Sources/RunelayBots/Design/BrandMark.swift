import SwiftUI

enum RbotsSymbolPart {
    case letter
    case slash
}

struct RbotsSymbol: Shape {
    var part: RbotsSymbolPart
    var split: CGFloat = 0

    var animatableData: CGFloat {
        get { split }
        set { split = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width / 572, rect.height / 592)
        let originX = rect.midX - 572 * scale / 2 - 226 * scale
        let originY = rect.midY - 592 * scale / 2 - 216 * scale
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: originX + x * scale, y: originY + y * scale)
        }
        var path = Path()
        switch part {
        case .letter:
            let dy = split
            path.move(to: point(295, 732 + dy))
            path.addLine(to: point(295, 422 + dy))
            path.addLine(to: point(385, 422 + dy))
            path.addLine(to: point(385, 467 + dy))
            path.addCurve(to: point(495, 420 + dy), control1: point(410, 437 + dy), control2: point(450, 420 + dy))
            path.addLine(to: point(495, 504 + dy))
            path.addCurve(to: point(385, 562 + dy), control1: point(447, 504 + dy), control2: point(410, 520 + dy))
            path.addLine(to: point(385, 732 + dy))
        case .slash:
            let dy = -split
            path.move(to: point(500, 732 + dy))
            path.addLine(to: point(590, 732 + dy))
            path.addLine(to: point(730, 292 + dy))
            path.addLine(to: point(640, 292 + dy))
        }
        path.closeSubpath()
        return path
    }
}

struct RbotsGlyph: View {
    var split: CGFloat = 0

    var body: some View {
        ZStack {
            RbotsSymbol(part: .letter, split: split)
                .fill(LinearGradient(colors: [Theme.silverFrom, Theme.silverTo], startPoint: .topLeading, endPoint: .bottomTrailing))
            RbotsSymbol(part: .slash, split: split)
                .fill(LinearGradient(colors: [Theme.slashFrom, Theme.slashTo], startPoint: .topLeading, endPoint: .bottomTrailing))
        }
    }
}

struct RunelayAppMark: View {
    var size: CGFloat = 32
    var split = false

    var body: some View {
        RbotsGlyph(split: split ? 18 : 0)
            .frame(width: size * 0.56, height: size * 0.56)
            .frame(width: size, height: size)
            .background(Theme.appIcon, in: RoundedRectangle(cornerRadius: size * 0.31, style: .continuous))
            .accessibilityLabel("r/bots")
    }
}
