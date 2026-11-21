import SwiftUI

struct ProviderLogo: View {
    let provider: String
    var size: CGFloat = 16

    var body: some View {
        switch provider {
        case "claude":
            logo("provider-claude", template: false)
        case "codex", "openai", "chatgpt":
            logo("provider-openai", template: true)
        case "cursor":
            logo("provider-cursor", template: true)
        case "grok", "xai":
            logo("provider-grok", template: false)
        default:
            Image(systemName: "bolt")
                .font(.system(size: size * 0.7, weight: .semibold))
                .foregroundStyle(Theme.textSecondary)
                .frame(width: size, height: size)
        }
    }

    private func logo(_ name: String, template: Bool) -> some View {
        Image(name)
            .renderingMode(template ? .template : .original)
            .resizable()
            .interpolation(.high)
            .aspectRatio(contentMode: .fit)
            .foregroundStyle(Theme.textPrimary)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}
