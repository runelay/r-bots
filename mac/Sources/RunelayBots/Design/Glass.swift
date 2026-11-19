import SwiftUI

struct GlassSurface<S: Shape>: ViewModifier {
    let shape: S
    let interactive: Bool
    let tint: Color?
    let fallback: Color

    func body(content: Content) -> some View {
        if #available(macOS 26.0, *) {
            content.glassEffect(glass, in: shape)
        } else {
            content.background(tint ?? fallback, in: shape)
        }
    }

    @available(macOS 26.0, *)
    private var glass: Glass {
        var value = Glass.regular
        if let tint {
            value = value.tint(tint)
        }
        if interactive {
            value = value.interactive()
        }
        return value
    }
}

struct GlassGroup<Content: View>: View {
    var spacing: CGFloat = Spacing.s
    @ViewBuilder let content: Content

    var body: some View {
        if #available(macOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) {
                content
            }
        } else {
            content
        }
    }
}

struct GlassMorphID: ViewModifier {
    let id: String
    let namespace: Namespace.ID

    func body(content: Content) -> some View {
        if #available(macOS 26.0, *) {
            content.glassEffectID(id, in: namespace)
        } else {
            content
        }
    }
}

extension View {
    func glassSurface<S: Shape>(_ shape: S, interactive: Bool = false, tint: Color? = nil, fallback: Color = Theme.surface) -> some View {
        modifier(GlassSurface(shape: shape, interactive: interactive, tint: tint, fallback: fallback))
    }

    func glassMorphID(_ id: String, in namespace: Namespace.ID) -> some View {
        modifier(GlassMorphID(id: id, namespace: namespace))
    }
}

struct TopBarAttachment<Bar: View>: ViewModifier {
    let bar: Bar

    func body(content: Content) -> some View {
        if #available(macOS 26.0, *) {
            content
                .safeAreaBar(edge: .top) {
                    bar
                }
                .scrollEdgeEffectStyle(.soft, for: .top)
        } else {
            content.safeAreaInset(edge: .top, spacing: 0) {
                bar
                    .frame(maxWidth: .infinity)
                    .background {
                        Rectangle()
                            .fill(.regularMaterial)
                            .mask {
                                LinearGradient(colors: [Theme.maskVisible, Theme.maskVisible, Theme.maskHidden], startPoint: .top, endPoint: .bottom)
                            }
                    }
            }
        }
    }
}

extension View {
    func topBar<Bar: View>(@ViewBuilder _ bar: () -> Bar) -> some View {
        modifier(TopBarAttachment(bar: bar()))
    }
}
