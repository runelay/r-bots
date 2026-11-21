import SwiftUI

struct RunelaySymbol: Shape {
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
        path.addPath(half(centerX: 492, centerY: 541 + split, direction: -1, point: point))
        path.addPath(half(centerX: 532, centerY: 482 - split, direction: 1, point: point))
        return path
    }

    private func half(centerX: CGFloat, centerY: CGFloat, direction: CGFloat, point: (CGFloat, CGFloat) -> CGPoint) -> Path {
        let radius: CGFloat = 256
        let handle = radius * 0.5523
        var path = Path()
        path.move(to: point(centerX, centerY - radius))
        path.addCurve(
            to: point(centerX + direction * radius, centerY),
            control1: point(centerX + direction * handle, centerY - radius),
            control2: point(centerX + direction * radius, centerY - handle)
        )
        path.addCurve(
            to: point(centerX, centerY + radius),
            control1: point(centerX + direction * radius, centerY + handle),
            control2: point(centerX + direction * handle, centerY + radius)
        )
        path.closeSubpath()
        return path
    }
}

struct RunelayAppMark: View {
    var size: CGFloat = 32
    var split = false

    var body: some View {
        RunelaySymbol(split: split ? 28 : 0)
            .fill(LinearGradient(colors: [Theme.silverFrom, Theme.silverTo], startPoint: .topLeading, endPoint: .bottomTrailing))
            .frame(width: size * 0.56, height: size * 0.56)
            .frame(width: size, height: size)
            .background(Theme.appIcon, in: RoundedRectangle(cornerRadius: size * 0.31, style: .continuous))
            .accessibilityLabel("r/bots")
    }
}
