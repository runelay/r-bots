import SwiftUI

struct ContextHandoffDivider: View {
    let handoff: ContextHandoff
    let fromName: String?
    let toName: String

    var body: some View {
        HStack(spacing: Spacing.m) {
            hairline
            HStack(spacing: Spacing.s) {
                Image(systemName: "arrow.left.arrow.right")
                    .font(.system(size: 10, weight: .semibold))
                Text(handoff.reason)
                if let from = handoff.fromAccount, let fromName {
                    side(account: from, name: fromName)
                    Image(systemName: "arrow.right")
                        .font(.system(size: 9, weight: .semibold))
                }
                side(account: handoff.toAccount, name: toName)
            }
            .font(TypeScale.caption)
            .foregroundStyle(Theme.textTertiary)
            .lineLimit(1)
            .fixedSize()
            hairline
        }
        .padding(.vertical, Spacing.s)
        .help(handoff.detail ?? handoff.reason)
        .accessibilityElement(children: .combine)
    }

    private var hairline: some View {
        Rectangle()
            .fill(Theme.paneDivider)
            .frame(height: 1)
            .frame(maxWidth: .infinity)
    }

    private func side(account: String, name: String) -> some View {
        HStack(spacing: Spacing.xs) {
            ProviderLogo(provider: account.split(separator: ":").last.map(String.init) ?? account, size: 12)
            Text(name)
        }
    }
}
