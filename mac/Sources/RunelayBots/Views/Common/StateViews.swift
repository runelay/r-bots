import SwiftUI

struct LoadFailedView: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: Spacing.m) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 22, weight: .regular))
                .foregroundStyle(Theme.textTertiary)
            Text("Não deu para carregar")
                .font(TypeScale.sectionTitle)
                .foregroundStyle(Theme.textPrimary)
            Text(message)
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
            Button("Tentar de novo", action: retry)
                .buttonStyle(.borderedProminent)
                .clickable()
        }
        .padding(Spacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct PanelEmptyState: View {
    let systemImage: String
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: Spacing.s) {
            Image(systemName: systemImage)
                .font(.system(size: 18, weight: .regular))
                .foregroundStyle(Theme.textTertiary)
            Text(title)
                .font(TypeScale.sectionTitle)
                .foregroundStyle(Theme.textSecondary)
            Text(message)
                .font(TypeScale.caption)
                .foregroundStyle(Theme.textTertiary)
                .multilineTextAlignment(.center)
        }
        .padding(Spacing.xl)
        .frame(maxWidth: .infinity)
    }
}

struct SkeletonRow: View {
    var width: CGFloat = 160

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .fill(Theme.surfaceRaised)
                .frame(width: width, height: 10)
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .fill(Theme.surface)
                .frame(width: width * 0.7, height: 8)
        }
        .frame(maxWidth: .infinity, minHeight: Metrics.rowHeight, alignment: .leading)
        .padding(.horizontal, Spacing.m)
        .accessibilityHidden(true)
    }
}
