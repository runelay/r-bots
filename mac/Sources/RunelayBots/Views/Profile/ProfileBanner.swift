import SwiftUI

struct ProfileBanner: View {
    var height: CGFloat = 120

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Theme.bannerStart, Theme.bannerMiddle, Theme.bannerEnd],
                startPoint: .leading,
                endPoint: .trailing
            )
            BannerStripes()
        }
        .frame(height: height)
        .frame(maxWidth: .infinity)
        .accessibilityHidden(true)
    }
}

struct BannerStripes: View {
    var body: some View {
        let colors = [Theme.stripeOnDark1, Theme.stripeOnDark2, Theme.stripeOnDark3, Theme.stripeOnDark4]
        Canvas { context, size in
            let thickness: CGFloat = 24
            let gap: CGFloat = 36
            for (index, color) in colors.enumerated() {
                let topStart = size.width - 168 + CGFloat(index) * gap
                var path = Path()
                path.move(to: CGPoint(x: topStart, y: 0))
                path.addLine(to: CGPoint(x: topStart + thickness, y: 0))
                path.addLine(to: CGPoint(x: topStart + thickness - size.height, y: size.height))
                path.addLine(to: CGPoint(x: topStart - size.height, y: size.height))
                path.closeSubpath()
                context.fill(path, with: .color(color))
            }
        }
        .allowsHitTesting(false)
    }
}

struct CharacterBadge: View {
    let bot: Bot
    let mood: CharacterMood
    var size: CGFloat = 80

    var body: some View {
        BotCharacter(bot: bot, mood: mood, size: size)
            .padding(Spacing.s)
            .background(Theme.surface, in: Circle())
    }
}

struct BannerPanel<Header: View, Content: View, Footer: View>: View {
    let bot: Bot
    let mood: CharacterMood
    var bannerHeight: CGFloat = 120
    let close: () -> Void
    @ViewBuilder let header: Header
    @ViewBuilder let content: Content
    @ViewBuilder let footer: Footer

    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .topTrailing) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ProfileBanner(height: bannerHeight)
                        VStack(alignment: .leading, spacing: Spacing.l) {
                            CharacterBadge(bot: bot, mood: mood, size: bannerHeight < 100 ? 64 : 80)
                                .padding(.top, bannerHeight < 100 ? -32 : -38)
                            header
                            content
                        }
                        .padding(.horizontal, Spacing.xxl)
                        .padding(.bottom, Spacing.l)
                    }
                }
                .scrollEdgesHidden()

                RoundIconButton(systemImage: "xmark", help: "Fechar (Esc)") {
                    close()
                }
                .padding(Spacing.m + 2)
            }
            footer
        }
    }
}
