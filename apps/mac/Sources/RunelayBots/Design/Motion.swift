import SwiftUI

enum Motion {
    static let spring = Animation.spring(response: 0.35, dampingFraction: 0.85)
    static let reduced = Animation.easeOut(duration: 0.18)
    static let crossFade = Animation.easeInOut(duration: 0.35)

    static func animation(reduceMotion: Bool) -> Animation {
        reduceMotion ? reduced : spring
    }

    static func insertion(reduceMotion: Bool) -> AnyTransition {
        if reduceMotion {
            return .opacity
        }
        return .asymmetric(
            insertion: .opacity.combined(with: .offset(y: 8)),
            removal: .opacity
        )
    }

    static func message(fromTrailing: Bool, reduceMotion: Bool) -> AnyTransition {
        if reduceMotion {
            return .opacity
        }
        let anchor: UnitPoint = fromTrailing ? .bottomTrailing : .bottomLeading
        return .asymmetric(
            insertion: .opacity
                .combined(with: .offset(y: 12))
                .combined(with: .scale(scale: 0.96, anchor: anchor)),
            removal: .opacity
        )
    }

    static func clear(reduceMotion: Bool) -> AnyTransition {
        if reduceMotion {
            return .opacity
        }
        return .asymmetric(
            insertion: .opacity,
            removal: .opacity.combined(with: .offset(y: -14))
        )
    }

    static func panel(reduceMotion: Bool) -> AnyTransition {
        if reduceMotion {
            return .opacity
        }
        return .move(edge: .trailing).combined(with: .opacity)
    }
}

struct SpringAnimated<Value: Equatable>: ViewModifier {
    @Environment(\.appReduceMotion) private var reduceMotion
    let value: Value

    func body(content: Content) -> some View {
        content.animation(Motion.animation(reduceMotion: reduceMotion), value: value)
    }
}

struct PressableButtonStyle: ButtonStyle {
    @Environment(\.appReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .clickable()
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.92 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(Motion.animation(reduceMotion: reduceMotion), value: configuration.isPressed)
    }
}

struct ScrollEdgesHidden: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 26.0, *) {
            content.scrollEdgeEffectHidden(true, for: .all)
        } else {
            content
        }
    }
}

struct SoftElevation: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    let lifted: Bool

    func body(content: Content) -> some View {
        let isDark = colorScheme == .dark
        let radius: CGFloat = isDark ? (lifted ? 8 : 6) : (lifted ? 14 : 12)
        let offset: CGFloat = isDark ? (lifted ? 2 : 1) : (lifted ? 5 : 4)
        content.shadow(
            color: lifted ? Theme.elevationShadowLifted : Theme.elevationShadow,
            radius: radius,
            y: offset
        )
    }
}

struct ClickablePointer: ViewModifier {
    func body(content: Content) -> some View {
        #if os(macOS)
            content.pointerStyle(.link)
        #else
            content
        #endif
    }
}

extension View {
    func softElevation(lifted: Bool = false) -> some View {
        modifier(SoftElevation(lifted: lifted))
    }

    func clickable() -> some View {
        modifier(ClickablePointer())
    }

    func springAnimation<Value: Equatable>(value: Value) -> some View {
        modifier(SpringAnimated(value: value))
    }

    func scrollEdgesHidden() -> some View {
        modifier(ScrollEdgesHidden())
    }
}
