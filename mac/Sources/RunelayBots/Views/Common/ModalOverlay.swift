import SwiftUI

struct ModalOverlay<Content: View>: View {
    let width: CGFloat
    let height: CGFloat?
    let dismiss: () -> Void
    @ViewBuilder let content: Content

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Theme.scrim
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture {
                        dismiss()
                    }
                    .accessibilityLabel("Fechar")
                    .accessibilityAddTraits(.isButton)

                panel(in: geometry.size)

                Button("Fechar") {
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)
                .opacity(0)
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
    }
}

extension ModalOverlay {
    @ViewBuilder
    fileprivate func panel(in size: CGSize) -> some View {
        if let height {
            content
                .frame(width: min(width, size.width - 48), height: min(height, size.height - 48))
                .modifier(PanelSurface())
        } else {
            content
                .frame(width: min(width, size.width - 48))
                .fixedSize(horizontal: false, vertical: true)
                .modifier(PanelSurface())
        }
    }
}

struct ModalTransition: ViewModifier {
    @Environment(\.appReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content.transition(
            reduceMotion
                ? .opacity
                : .opacity.combined(with: .scale(scale: 0.96))
        )
    }
}

struct PanelSurface: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(Theme.inspectorBackground, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
            .softElevation(lifted: true)
    }
}
