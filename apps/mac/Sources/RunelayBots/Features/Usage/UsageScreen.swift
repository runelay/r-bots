import Charts
import SwiftUI

struct UsageScreen: View {
    @Environment(\.appReduceMotion) private var reduceMotion
    @State private var store = UsageStore.shared

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                PageContainer {
                    VStack(alignment: .leading, spacing: Spacing.xl) {
                        HStack(alignment: .center, spacing: Spacing.l) {
                            ScreenTitle(title: tr("Uso"), subtitle: tr("Limites de cada conta e tokens gastos pelos bots."))
                            Spacer(minLength: Spacing.l)
                            UsageRefreshButton(isBusy: store.summaryLoading) {
                                Task { await store.refreshLimits(force: true) }
                                store.reloadSummary()
                            }
                        }

                        HStack(alignment: .center, spacing: Spacing.m) {
                            UsageSegmented(options: UsageTab.allCases.map { ($0, $0.title) }, selection: $store.tab, namespaceID: "tab")
                            Spacer(minLength: Spacing.m)
                            if store.tab != .limits {
                                UsageSegmented(options: UsageRange.allCases.map { ($0, $0.title) }, selection: $store.range, namespaceID: "range")
                            }
                            UsageFilterMenu(title: tr("Provedor"), options: [(nil, tr("Todos")), ("claude", "Claude"), ("codex", "Codex")], selection: $store.provider)
                            if store.accounts.count > 1 {
                                UsageFilterMenu(title: tr("Conta"), options: [(nil, tr("Todas"))] + store.accounts.map { ($0.id, $0.label) }, selection: $store.account)
                            }
                        }

                        Group {
                            switch store.tab {
                            case .limits:
                                UsageLimitsTab(store: store)
                            case .tokens:
                                UsageTokensTab(store: store, mode: .tokens)
                            case .cost:
                                UsageTokensTab(store: store, mode: .cost)
                            }
                        }
                        .transition(Motion.insertion(reduceMotion: reduceMotion))
                        .id(store.tab)
                    }
                }
                .padding(.top, Spacing.xl + 4)
                .padding(.bottom, Spacing.xxl)
            }
            .scrollEdgesHidden()
            .background(Theme.background)
            .animation(Motion.animation(reduceMotion: reduceMotion), value: store.tab)
            .task {
                if !store.limitsLoaded {
                    await store.refreshLimits()
                }
                reveal(store.focusAccount, proxy)
                if store.summary == nil {
                    store.reloadSummary()
                }
            }
            .onChange(of: store.focusAccount) { reveal(store.focusAccount, proxy) }
            .onChange(of: store.limitsLoaded) { reveal(store.focusAccount, proxy) }
        }
        .onChange(of: store.range) { store.reloadSummary() }
        .onChange(of: store.provider) { store.reloadSummary() }
        .onChange(of: store.account) { store.reloadSummary() }
    }

    private func reveal(_ id: String?, _ proxy: ScrollViewProxy) {
        guard let id, store.tab == .limits, store.accounts.contains(where: { $0.id == id }) else { return }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(80))
            withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                proxy.scrollTo(UsageScreen.anchor(id), anchor: .top)
            }
        }
    }

    static func anchor(_ id: String) -> String { "usage-account-\(id)" }
}

private struct UsageRefreshButton: View {
    let isBusy: Bool
    let action: () -> Void
    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            Group {
                if isBusy {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 13, weight: .medium))
                }
            }
            .foregroundStyle(Theme.textSecondary)
            .frame(width: 32, height: 32)
            .background(isHovering ? Theme.hover : Theme.maskHidden, in: Circle())
            .contentShape(Circle())
        }
        .buttonStyle(PressableButtonStyle())
        .onHover { isHovering = $0 }
        .help("Atualizar agora")
    }
}

struct UsageSegmented<Value: Hashable>: View {
    let options: [(Value, String)]
    @Binding var selection: Value
    let namespaceID: String
    @Namespace private var namespace
    @Environment(\.appReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.0) { option in
                let isSelected = option.0 == selection
                Button {
                    withAnimation(Motion.animation(reduceMotion: reduceMotion)) {
                        selection = option.0
                    }
                } label: {
                    Text(option.1)
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(isSelected ? Theme.textPrimary : Theme.textSecondary)
                        .padding(.horizontal, Spacing.m)
                        .frame(height: 28)
                        .background {
                            if isSelected {
                                Capsule()
                                    .fill(Theme.background)
                                    .softElevation()
                                    .matchedGeometryEffect(id: namespaceID, in: namespace)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .clickable()
            }
        }
        .padding(3)
        .background(Theme.surface, in: Capsule())
    }
}

private struct UsageFilterMenu: View {
    let title: String
    let options: [(String?, String)]
    @Binding var selection: String?

    var body: some View {
        GlassSelect(
            options: options.map { GlassSelectOption($0.1, value: $0.0) },
            selection: $selection,
            prefix: title,
            help: title,
            minWidth: 160
        )
    }
}

private struct UsageCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(Spacing.l)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
    }
}

private struct UsageNote: View {
    let text: String
    var systemImage = "info.circle"
    var color = Theme.textSecondary

    var body: some View {
        Label {
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: systemImage)
        }
        .font(TypeScale.caption)
        .foregroundStyle(color)
    }
}

private struct UsageLimitsTab: View {
    let store: UsageStore

    private var visibleAccounts: [UsageLimitAccount] {
        ["claude", "codex"].flatMap { provider in
            store.accounts(for: provider).filter { account in
                (store.provider == nil || store.provider == provider) && (store.account == nil || store.account == account.id)
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xxl) {
            if let error = store.limitsError {
                UsageNote(text: error, systemImage: "exclamationmark.triangle", color: Theme.attention)
            }
            if !store.limitsLoaded {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, minHeight: 120)
            } else if visibleAccounts.isEmpty {
                UsageNote(text: tr("Nenhuma conta com limite para mostrar com esses filtros."))
            }
            ForEach(visibleAccounts) { account in
                UsageAccountLimits(account: account)
                    .id(UsageScreen.anchor(account.id))
            }
        }
    }
}

private struct UsageAccountLimits: View {
    let account: UsageLimitAccount
    private var store: UsageStore { .shared }

    private var accounts: [UsageLimitAccount] { [account] }

    private var windowLabels: [String] {
        var seen: [String] = []
        let order = ["session", "weekly", "monthly", "weekly_model"]
        let all = accounts.flatMap(\.windows).sorted { (order.firstIndex(of: $0.kind) ?? 9) < (order.firstIndex(of: $1.kind) ?? 9) }
        for window in all where !seen.contains(window.label) {
            seen.append(window.label)
        }
        return seen
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            HStack(spacing: Spacing.s) {
                ProviderLogo(provider: account.provider, size: 18)
                Text(account.label)
                    .font(TypeScale.sectionTitle)
                    .foregroundStyle(Theme.textPrimary)
                if let plan = account.plan, !plan.isEmpty {
                    RoleTag(text: plan.capitalized)
                }
                if account.isDefault == true, store.accounts(for: account.provider).count > 1 {
                    RoleTag(text: tr("Padrão"))
                }
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 300), spacing: Spacing.m, alignment: .top)], alignment: .leading, spacing: Spacing.m) {
                ForEach(windowLabels, id: \.self) { label in
                    UsageLimitCard(label: label, accounts: accounts)
                }
            }
            if !account.ok {
                UsageNote(text: account.error ?? tr("Sem dados desta conta."), systemImage: "exclamationmark.circle", color: Theme.textTertiary)
            }
            if account.ok, account.windows.contains(where: { $0.remainingPercent < 25 }), let line = UsageStore.failoverLine(account) {
                UsageNote(text: tr("Se %1$@ acabar: %2$@", account.label, line), systemImage: "arrow.triangle.swap", color: Theme.attention)
            }
        }
    }
}

private struct UsageLimitCard: View {
    let label: String
    let accounts: [UsageLimitAccount]

    private var entries: [(account: UsageLimitAccount, window: UsageLimitWindow)] {
        accounts.compactMap { account in
            account.windows.first { $0.label == label }.map { (account, $0) }
        }
    }

    var body: some View {
        let lowest = entries.min { $0.window.remainingPercent < $1.window.remainingPercent }
        UsageCard {
            VStack(alignment: .leading, spacing: Spacing.m) {
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text(label)
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(Theme.textSecondary)
                    HStack(alignment: .firstTextBaseline, spacing: Spacing.xs) {
                        Text(UsageFormat.percent(lowest?.window.remainingPercent ?? 0))
                            .font(BrandFonts.sans(30, weight: .semibold).monospacedDigit())
                            .lineLimit(1)
                            .foregroundStyle(UsagePalette.remaining(lowest?.window.remainingPercent))
                            .contentTransition(.numericText())
                        Text("restante")
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textTertiary)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        if let until = UsageFormat.until(lowest?.window.resetDate) {
                            Text("volta em \(until)")
                                .font(TypeScale.caption.monospacedDigit())
                                .foregroundStyle(Theme.textSecondary)
                                .lineLimit(1)
                                .fixedSize()
                        }
                    }
                }
                VStack(alignment: .leading, spacing: Spacing.s + 2) {
                    ForEach(entries, id: \.account.id) { entry in
                        UsageAccountBar(account: entry.account, window: entry.window, showsName: entries.count > 1)
                    }
                }
            }
        }
    }
}

private struct UsageAccountBar: View {
    let account: UsageLimitAccount
    let window: UsageLimitWindow
    var showsName = true

    private var paceHelp: String {
        guard let pace = window.pacePercent else { return "" }
        if window.remainingPercent + 5 < pace { return tr("Gastando mais rápido que o ritmo da janela.") }
        if window.remainingPercent > pace + 5 { return tr("Abaixo do ritmo: sobra limite.") }
        return tr("No ritmo da janela.")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(spacing: Spacing.xs) {
                if showsName {
                    Text(account.label)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                }
                Spacer(minLength: Spacing.s)
                if let until = UsageFormat.until(window.resetDate) {
                    Text(until)
                        .font(TypeScale.caption.monospacedDigit())
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                        .fixedSize()
                }
                Text(UsageFormat.percent(window.remainingPercent))
                    .font(TypeScale.captionStrong.monospacedDigit())
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .fixedSize()
                    .frame(minWidth: 36, alignment: .trailing)
            }
            GeometryReader { geometry in
                let width = geometry.size.width
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(UsagePalette.track)
                    Capsule()
                        .fill(UsagePalette.remaining(window.remainingPercent))
                        .frame(width: max(0, width * window.remainingPercent / 100))
                    if let pace = window.pacePercent {
                        RoundedRectangle(cornerRadius: 1, style: .continuous)
                            .fill(Theme.textPrimary)
                            .frame(width: 2, height: 10)
                            .offset(x: min(max(0, width * pace / 100 - 1), width - 2))
                    }
                }
            }
            .frame(height: 6)
            .springAnimation(value: window.remainingPercent)
            .help(paceHelp)
        }
    }
}

enum UsageMode {
    case tokens
    case cost
}

private struct ChartPoint: Identifiable, Hashable {
    let date: Date
    let provider: String
    let value: Double

    var id: String { "\(date.timeIntervalSince1970)|\(provider)" }
}

private struct UsageTokensTab: View {
    let store: UsageStore
    let mode: UsageMode

    var body: some View {
        if let summary = store.summary {
            content(summary)
        } else if let error = store.summaryError {
            UsageNote(text: error, systemImage: "exclamationmark.triangle", color: Theme.attention)
        } else {
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity, minHeight: 200)
        }
    }

    @ViewBuilder
    private func content(_ summary: UsageSummary) -> some View {
        let totals = summary.totals
        VStack(alignment: .leading, spacing: Spacing.xl) {
            HStack(alignment: .lastTextBaseline, spacing: Spacing.l) {
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text(mode == .tokens ? "Total processado" : "Custo estimado")
                        .font(TypeScale.captionStrong)
                        .foregroundStyle(Theme.textSecondary)
                    Text(mode == .tokens ? UsageFormat.tokens(totals.processed) : UsageFormat.usd(totals.costUsd))
                        .font(BrandFonts.sans(34, weight: .semibold).monospacedDigit())
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                        .foregroundStyle(Theme.textPrimary)
                        .contentTransition(.numericText())
                }
                Text(
                    mode == .tokens
                        ? "\(Int(totals.sessions)) sessões · \(UsageFormat.tokens(totals.requests)) chamadas"
                        : "pelo preço de API, sem a assinatura"
                )
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(Theme.textSecondary)
                Spacer(minLength: 0)
                if store.summaryLoading {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            ForEach(notes(summary), id: \.self) { note in
                UsageNote(text: note)
            }

            UsageCard {
                VStack(alignment: .leading, spacing: Spacing.m) {
                    Text(mode == .tokens ? (summary.granularity == "hour" ? "Tokens por hora" : "Tokens por dia") : (summary.granularity == "hour" ? "Custo por hora" : "Custo por dia"))
                        .font(TypeScale.sectionTitle)
                        .foregroundStyle(Theme.textPrimary)
                    UsageAreaChart(points: points(summary), hourly: summary.granularity == "hour", mode: mode)
                }
            }

            if mode == .tokens {
                UsageStatGrid(stats: [
                    UsageStat(title: tr("Processados"), value: UsageFormat.tokens(totals.processed)),
                    UsageStat(title: tr("Input em cache"), value: UsageFormat.tokens(totals.cacheRead)),
                    UsageStat(title: tr("Input fora do cache"), value: UsageFormat.tokens(totals.input + totals.cacheWrite)),
                    UsageStat(title: tr("Output"), value: UsageFormat.tokens(totals.output)),
                    UsageStat(title: tr("Economia do cache"), value: UsageFormat.usd(totals.savingsUsd), detail: cacheShare(totals)),
                ])
                UsageTypeBar(
                    title: tr("Tokens por tipo"),
                    segments: [
                        (tr("Fora do cache"), totals.input, UsagePalette.uncached),
                        (tr("Escrita no cache"), totals.cacheWrite, UsagePalette.cacheWrite),
                        (tr("Leitura do cache"), totals.cacheRead, UsagePalette.cacheRead),
                        (tr("Output"), totals.output, UsagePalette.output),
                    ], format: UsageFormat.tokens)
            } else {
                UsageStatGrid(stats: [
                    UsageStat(title: tr("Custo total"), value: UsageFormat.usd(totals.costUsd)),
                    UsageStat(title: tr("Economia do cache"), value: UsageFormat.usd(totals.savingsUsd)),
                    UsageStat(title: tr("Por sessão"), value: UsageFormat.usd(totals.sessions > 0 ? totals.costUsd / totals.sessions : 0)),
                    UsageStat(title: tr("Por chamada"), value: UsageFormat.usd(totals.requests > 0 ? totals.costUsd / totals.requests : 0)),
                ])
                UsageTypeBar(
                    title: tr("Custo por tipo"),
                    segments: [
                        (tr("Input fora do cache"), summary.costByType.input, UsagePalette.uncached),
                        (tr("Escrita no cache"), summary.costByType.cacheWrite, UsagePalette.cacheWrite),
                        (tr("Leitura do cache"), summary.costByType.cacheRead, UsagePalette.cacheRead),
                        (tr("Output"), summary.costByType.output, UsagePalette.output),
                    ], format: UsageFormat.usd)
                UsageSpeedCard(speeds: summary.speeds)
            }

            if let accounts = summary.accounts, accounts.count > 1 {
                UsageAccountsCard(accounts: accounts, mode: mode)
            }

            UsageDetailTable(rows: summary.detail, mode: mode)
        }
    }

    private func cacheShare(_ totals: UsageTotals) -> String {
        let input = totals.input + totals.cacheWrite + totals.cacheRead
        guard input > 0 else { return "" }
        return tr("%@ do input veio do cache", UsageFormat.percent(totals.cacheRead / input * 100))
    }

    private func notes(_ summary: UsageSummary) -> [String] {
        var list: [String] = []
        if mode == .cost, summary.totals.unpricedTokens > 0 {
            list.append(tr("%@ tokens são de modelos sem preço público e ficaram fora da conta.", UsageFormat.tokens(summary.totals.unpricedTokens)))
        }
        return list
    }

    private func points(_ summary: UsageSummary) -> [ChartPoint] {
        let hourly = summary.granularity == "hour"
        var buckets = Set<String>()
        var providers = Set<String>()
        var values: [String: Double] = [:]
        for point in summary.series {
            buckets.insert(point.bucket)
            providers.insert(point.provider)
            values["\(point.bucket)|\(point.provider)", default: 0] += mode == .tokens ? point.tokens : point.costUsd
        }
        var result: [ChartPoint] = []
        for bucket in buckets {
            guard let date = hourly ? UsageFormat.date(bucket) : UsageFormat.day(bucket) else { continue }
            for provider in providers.sorted() {
                result.append(ChartPoint(date: date, provider: UsageFormat.providerName(provider), value: values["\(bucket)|\(provider)"] ?? 0))
            }
        }
        return result.sorted { $0.date < $1.date }
    }
}

private struct UsageAccountsCard: View {
    let accounts: [UsageAccountTotals]
    let mode: UsageMode

    private func value(_ account: UsageAccountTotals) -> Double {
        mode == .tokens ? account.processed : account.costUsd
    }

    var body: some View {
        let total = max(accounts.map(value).reduce(0, +), 1)
        UsageCard {
            VStack(alignment: .leading, spacing: Spacing.m) {
                Text(mode == .tokens ? "Tokens por conta" : "Custo por conta")
                    .font(TypeScale.sectionTitle)
                    .foregroundStyle(Theme.textPrimary)
                ForEach(accounts) { account in
                    VStack(alignment: .leading, spacing: Spacing.xs) {
                        HStack(spacing: Spacing.s) {
                            ProviderLogo(provider: account.provider, size: 14)
                            Text(account.label)
                                .font(TypeScale.caption)
                                .foregroundStyle(Theme.textPrimary)
                                .lineLimit(1)
                            Spacer(minLength: Spacing.s)
                            Text("\(Int(account.sessions)) sessões")
                                .font(TypeScale.caption.monospacedDigit())
                                .foregroundStyle(Theme.textTertiary)
                                .fixedSize()
                            Text(mode == .tokens ? UsageFormat.tokens(account.processed) : UsageFormat.usd(account.costUsd))
                                .font(TypeScale.captionStrong.monospacedDigit())
                                .foregroundStyle(Theme.textPrimary)
                                .contentTransition(.numericText())
                                .fixedSize()
                                .frame(minWidth: 64, alignment: .trailing)
                        }
                        GeometryReader { geometry in
                            ZStack(alignment: .leading) {
                                Capsule()
                                    .fill(UsagePalette.track)
                                Capsule()
                                    .fill(UsagePalette.provider(account.provider))
                                    .frame(width: max(0, geometry.size.width * value(account) / total))
                            }
                        }
                        .frame(height: 6)
                        .springAnimation(value: value(account))
                    }
                }
            }
        }
    }
}

private struct UsageAreaChart: View {
    let points: [ChartPoint]
    let hourly: Bool
    let mode: UsageMode
    @State private var hovered: Date?

    private static let areaSuffix = " · área"

    private struct Stack: Identifiable {
        let date: Date
        let provider: String
        let value: Double
        let end: Double

        var id: String { "\(date.timeIntervalSince1970)|\(provider)" }
    }

    private var dates: [Date] {
        Array(Set(points.map(\.date))).sorted()
    }

    private var providers: [String] {
        Array(Set(points.map(\.provider))).sorted { total($0) > total($1) }
    }

    private var stacks: [Stack] {
        let order = providers
        var values: [String: Double] = [:]
        for point in points {
            values[point.id, default: 0] += point.value
        }
        var result: [Stack] = []
        for date in dates {
            var base = 0.0
            for provider in order {
                let value = values["\(date.timeIntervalSince1970)|\(provider)"] ?? 0
                base += value
                result.append(Stack(date: date, provider: provider, value: value, end: base))
            }
        }
        return result
    }

    private var ticks: [Date] {
        let all = dates
        guard all.count > 4 else { return all }
        let step = Int((Double(all.count - 1) / 3).rounded(.up))
        return stride(from: 0, to: all.count, by: step).map { all[$0] }
    }

    private func upperBound(_ stacks: [Stack]) -> Double {
        let peak = stacks.map(\.end).max() ?? 0
        guard peak > 0 else { return 1 }
        let target = peak * 1.1
        let magnitude = pow(10, floor(log10(target)))
        let step = [1, 2, 2.5, 5, 10].first { $0 * magnitude >= target } ?? 10
        return step * magnitude
    }

    private func total(_ provider: String) -> Double {
        points.filter { $0.provider == provider }.reduce(0) { $0 + $1.value }
    }

    private func color(_ provider: String) -> Color {
        UsagePalette.provider(provider.lowercased())
    }

    private func style(_ key: String) -> AnyShapeStyle {
        guard key.hasSuffix(Self.areaSuffix) else { return AnyShapeStyle(color(key)) }
        let base = color(String(key.dropLast(Self.areaSuffix.count)))
        return AnyShapeStyle(LinearGradient(colors: [base.opacity(0.32), base.opacity(0.03)], startPoint: .top, endPoint: .bottom))
    }

    private func format(_ value: Double) -> String {
        mode == .tokens ? UsageFormat.tokens(value) : UsageFormat.usd(value)
    }

    private func axisLabel(_ value: Double) -> String {
        guard mode == .cost else { return UsageFormat.tokens(value) }
        let formatter = NumberFormatter()
        formatter.locale = LanguageStore.shared.locale
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = value >= 1000 ? 1 : 0
        let shown = value >= 1000 ? value / 1000 : value
        let number = formatter.string(from: NSNumber(value: shown)) ?? "\(Int(shown))"
        return tr("US$ %@", value >= 1000 ? tr("%@ mil", number) : number)
    }

    private func label(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = LanguageStore.shared.locale
        formatter.timeZone = TimeZone(identifier: "America/Sao_Paulo")
        formatter.dateFormat = hourly ? "d MMM, HH'h'" : "EEE, d MMM"
        return formatter.string(from: date)
    }

    private func tick(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = LanguageStore.shared.locale
        formatter.timeZone = TimeZone(identifier: "America/Sao_Paulo")
        formatter.dateFormat = hourly ? "HH'h'" : "d MMM"
        return formatter.string(from: date)
    }

    var body: some View {
        if points.isEmpty {
            Text("Sem uso neste período.")
                .font(TypeScale.rowSubtitle)
                .foregroundStyle(Theme.textTertiary)
                .frame(maxWidth: .infinity, minHeight: 200)
        } else {
            VStack(alignment: .leading, spacing: Spacing.xl) {
                legend
                chart
                    .aspectRatio(2.8, contentMode: .fit)
                    .frame(minHeight: 180, maxHeight: 340)
            }
        }
    }

    private var legend: some View {
        HStack(spacing: Spacing.l) {
            ForEach(providers, id: \.self) { provider in
                HStack(spacing: Spacing.xs + 2) {
                    ProviderLogo(provider: provider.lowercased(), size: 14)
                    Text(provider)
                        .foregroundStyle(Theme.textSecondary)
                    Text(format(total(provider)))
                        .foregroundStyle(Theme.textPrimary)
                        .monospacedDigit()
                }
                .font(TypeScale.caption)
                .lineLimit(1)
                .fixedSize()
            }
            Spacer(minLength: 0)
        }
    }

    private var chart: some View {
        let stacks = stacks
        return Chart {
            ForEach(stacks) { item in
                AreaMark(
                    x: .value("Data", item.date),
                    y: .value("Valor", item.value),
                    stacking: .standard
                )
                .foregroundStyle(by: .value("Série", item.provider + Self.areaSuffix))
                .interpolationMethod(.monotone)
            }
            ForEach(stacks) { item in
                LineMark(
                    x: .value("Data", item.date),
                    y: .value("Valor", item.end),
                    series: .value("Linha", item.provider)
                )
                .foregroundStyle(by: .value("Série", item.provider))
                .interpolationMethod(.monotone)
                .lineStyle(StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
            }
            if let hovered {
                RuleMark(x: .value("Data", hovered))
                    .foregroundStyle(Theme.textTertiary.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1))
                ForEach(stacks.filter { $0.date == hovered }) { item in
                    PointMark(x: .value("Data", item.date), y: .value("Valor", item.end))
                        .symbolSize(42)
                        .foregroundStyle(by: .value("Série", item.provider))
                }
            }
        }
        .chartForegroundStyleScale { (key: String) in style(key) }
        .chartLegend(.hidden)
        .chartYScale(domain: 0...upperBound(stacks))
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { value in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5))
                    .foregroundStyle(Theme.paneDivider.opacity(0.6))
                AxisValueLabel {
                    if let number = value.as(Double.self) {
                        Text(axisLabel(number))
                            .font(TypeScale.caption.monospacedDigit())
                            .foregroundStyle(Theme.textTertiary)
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
            }
        }
        .chartXAxis {
            AxisMarks(values: ticks) { value in
                AxisValueLabel(anchor: .top) {
                    if let date = value.as(Date.self) {
                        Text(tick(date))
                            .font(TypeScale.caption)
                            .foregroundStyle(Theme.textTertiary)
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
            }
        }
        .chartOverlay { proxy in
            GeometryReader { geometry in
                let plot = proxy.plotFrame.map { geometry[$0] } ?? .zero
                ZStack(alignment: .topLeading) {
                    Rectangle()
                        .fill(.clear)
                        .contentShape(Rectangle())
                        .onContinuousHover { phase in
                            switch phase {
                            case .active(let location):
                                let x = location.x - plot.origin.x
                                guard x >= 0, x <= plot.width, let date: Date = proxy.value(atX: x) else {
                                    hovered = nil
                                    return
                                }
                                hovered = dates.min { abs($0.timeIntervalSince(date)) < abs($1.timeIntervalSince(date)) }
                            case .ended:
                                hovered = nil
                            }
                        }
                    if let hovered, let position = proxy.position(forX: hovered) {
                        let x = plot.minX + position
                        let flipped = x > plot.midX
                        tooltip(hovered)
                            .frame(width: max(0, flipped ? x - plot.minX - Spacing.s : plot.maxX - x - Spacing.s), alignment: flipped ? .trailing : .leading)
                            .offset(x: flipped ? plot.minX : x + Spacing.s, y: plot.minY + Spacing.xs)
                            .allowsHitTesting(false)
                    }
                }
            }
        }
    }

    private func tooltip(_ date: Date) -> some View {
        let items = providers.map { provider in
            (provider, points.first { $0.date == date && $0.provider == provider }?.value ?? 0)
        }
        let total = items.reduce(0) { $0 + $1.1 }
        return VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(label(date))
                .font(TypeScale.captionStrong)
                .foregroundStyle(Theme.textPrimary)
            ForEach(items, id: \.0) { item in
                HStack(spacing: Spacing.xs + 2) {
                    ProviderLogo(provider: item.0.lowercased(), size: 12)
                    Text(item.0)
                        .foregroundStyle(Theme.textSecondary)
                    Spacer(minLength: Spacing.m)
                    Text(format(item.1))
                        .foregroundStyle(Theme.textPrimary)
                        .monospacedDigit()
                }
                .font(TypeScale.caption)
            }
            if items.count > 1 {
                HStack(spacing: Spacing.xs + 2) {
                    Text("Total")
                        .foregroundStyle(Theme.textSecondary)
                    Spacer(minLength: Spacing.m)
                    Text(format(total))
                        .foregroundStyle(Theme.textPrimary)
                        .monospacedDigit()
                }
                .font(TypeScale.captionStrong)
            }
        }
        .lineLimit(1)
        .fixedSize()
        .frame(minWidth: 160, alignment: .leading)
        .padding(Spacing.s + 2)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        .softElevation(lifted: true)
    }
}

private struct UsageStat: View {
    let title: String
    let value: String
    var detail = ""

    var body: some View {
        UsageCard {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(title)
                    .font(TypeScale.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                Text(value)
                    .font(BrandFonts.sans(20, weight: .semibold).monospacedDigit())
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .contentTransition(.numericText())
                if !detail.isEmpty {
                    Text(detail)
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                }
            }
            .frame(maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

private struct UsageStatGrid: View {
    let stats: [UsageStat]

    var body: some View {
        ViewThatFits(in: .horizontal) {
            grid(columns: stats.count)
            if stats.count > 3 {
                grid(columns: 3)
            }
            grid(columns: 2)
        }
    }

    private func grid(columns: Int) -> some View {
        VStack(spacing: Spacing.m) {
            ForEach(Array(stride(from: 0, to: stats.count, by: columns)), id: \.self) { start in
                HStack(alignment: .top, spacing: Spacing.m) {
                    ForEach(start..<start + columns, id: \.self) { index in
                        if index < stats.count {
                            stats[index]
                        } else {
                            Color.clear
                                .frame(maxWidth: .infinity, maxHeight: 0)
                        }
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

private struct UsageTypeBar: View {
    let title: String
    let segments: [(String, Double, Color)]
    let format: (Double) -> String

    var body: some View {
        let total = max(segments.reduce(0) { $0 + $1.1 }, 0.000_001)
        UsageCard {
            VStack(alignment: .leading, spacing: Spacing.m) {
                Text(title)
                    .font(TypeScale.sectionTitle)
                    .foregroundStyle(Theme.textPrimary)
                GeometryReader { geometry in
                    HStack(spacing: 2) {
                        ForEach(segments, id: \.0) { segment in
                            if segment.1 > 0 {
                                Rectangle()
                                    .fill(segment.2)
                                    .frame(width: max(2, (geometry.size.width - CGFloat(segments.count) * 2) * segment.1 / total))
                            }
                        }
                    }
                    .clipShape(Capsule())
                }
                .frame(height: 10)
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: Spacing.l) {
                        ForEach(segments, id: \.0) { segment in
                            legendItem(segment, total: total)
                        }
                    }
                    Grid(alignment: .leading, horizontalSpacing: Spacing.l, verticalSpacing: Spacing.s) {
                        ForEach(Array(stride(from: 0, to: segments.count, by: 2)), id: \.self) { start in
                            GridRow {
                                ForEach(segments[start..<min(start + 2, segments.count)], id: \.0) { segment in
                                    legendItem(segment, total: total)
                                }
                            }
                        }
                    }
                    VStack(alignment: .leading, spacing: Spacing.s) {
                        ForEach(segments, id: \.0) { segment in
                            legendItem(segment, total: total)
                        }
                    }
                }
            }
        }
    }

    private func legendItem(_ segment: (String, Double, Color), total: Double) -> some View {
        HStack(spacing: Spacing.xs + 2) {
            Circle()
                .fill(segment.2)
                .frame(width: 8, height: 8)
            Text(segment.0)
                .foregroundStyle(Theme.textSecondary)
            Text(format(segment.1))
                .foregroundStyle(Theme.textPrimary)
                .monospacedDigit()
            Text(UsageFormat.percent(segment.1 / total * 100))
                .foregroundStyle(Theme.textTertiary)
                .monospacedDigit()
        }
        .font(TypeScale.caption)
        .lineLimit(1)
        .fixedSize()
    }
}

private struct UsageSpeedCard: View {
    let speeds: [UsageSpeed]

    var body: some View {
        UsageCard {
            VStack(alignment: .leading, spacing: Spacing.m) {
                Text("Custo por velocidade")
                    .font(TypeScale.sectionTitle)
                    .foregroundStyle(Theme.textPrimary)
                if speeds.isEmpty {
                    Text("Sem uso neste período.")
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                }
                ForEach(speeds, id: \.speed) { speed in
                    HStack {
                        Text(speed.speed == "fast" ? "Rápido" : "Padrão")
                            .foregroundStyle(Theme.textPrimary)
                        Text(UsageFormat.tokens(speed.tokens) + " tokens")
                            .foregroundStyle(Theme.textTertiary)
                        Spacer()
                        Text(UsageFormat.usd(speed.costUsd))
                            .foregroundStyle(Theme.textPrimary)
                            .monospacedDigit()
                    }
                    .font(TypeScale.rowSubtitle)
                }
            }
        }
    }
}

private enum DetailGrouping: Hashable {
    case model
    case day
}

private struct DetailLine: Identifiable {
    let id: String
    let title: String
    let subtitle: String
    let provider: String?
    var input: Double = 0
    var cacheRead: Double = 0
    var output: Double = 0
    var processed: Double = 0
    var cost: Double = 0
    var priced = false
}

private struct UsageDetailTable: View {
    let rows: [UsageDetailRow]
    let mode: UsageMode
    @State private var grouping: DetailGrouping = .model
    @State private var rowFrames: [String: CGRect] = [:]
    @State private var hoveredLine: String?

    nonisolated private static let space = "usage-detail"

    private var lines: [DetailLine] {
        var map: [String: DetailLine] = [:]
        for row in rows {
            let key = grouping == .model ? "\(row.provider)|\(row.model)" : row.day
            var line =
                map[key]
                ?? DetailLine(
                    id: key,
                    title: grouping == .model ? UsageFormat.modelName(row.model) : UsageFormat.dayLabel(row.day),
                    subtitle: grouping == .model ? UsageFormat.providerName(row.provider) : "",
                    provider: grouping == .model ? row.provider : nil
                )
            line.input += row.input + row.cacheWrite
            line.cacheRead += row.cacheRead
            line.output += row.output
            line.processed += row.processed
            if let cost = row.costUsd {
                line.cost += cost
                line.priced = true
            }
            map[key] = line
        }
        if grouping == .day {
            return map.values.sorted { $0.id > $1.id }
        }
        return map.values.sorted { mode == .cost ? $0.cost > $1.cost : $0.processed > $1.processed }
    }

    var body: some View {
        let lines = lines
        let totalShare = max(lines.reduce(0) { $0 + share(of: $1) }, 0.000_001)
        UsageCard {
            VStack(alignment: .leading, spacing: Spacing.m) {
                HStack {
                    Text("Detalhamento")
                        .font(TypeScale.sectionTitle)
                        .foregroundStyle(Theme.textPrimary)
                    Spacer()
                    UsageSegmented(options: [(DetailGrouping.model, tr("Modelo")), (DetailGrouping.day, tr("Dia"))], selection: $grouping, namespaceID: "detail")
                }
                Grid(alignment: .trailing, horizontalSpacing: Spacing.l, verticalSpacing: 0) {
                    GridRow {
                        Text(grouping == .model ? "Modelo" : "Dia")
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .gridColumnAlignment(.leading)
                        Text("Fora do cache")
                        Text("Em cache")
                        Text("Output")
                        Text("Total")
                        Text("Custo")
                    }
                    .lineLimit(1)
                    .fixedSize(horizontal: false, vertical: true)
                    .font(TypeScale.captionStrong)
                    .foregroundStyle(Theme.textTertiary)
                    .padding(.bottom, Spacing.xs)
                    ForEach(lines) { line in
                        GridRow {
                            VStack(alignment: .leading, spacing: Spacing.xs + 1) {
                                HStack(spacing: Spacing.s) {
                                    if let provider = line.provider {
                                        ProviderLogo(provider: provider, size: 14)
                                    }
                                    Text(line.title)
                                        .foregroundStyle(Theme.textPrimary)
                                        .lineLimit(1)
                                }
                                Capsule()
                                    .fill(UsagePalette.track)
                                    .frame(height: 3)
                                    .overlay(alignment: .leading) {
                                        Capsule()
                                            .fill(line.provider.map { UsagePalette.provider($0) } ?? Theme.brandAccent)
                                            .scaleEffect(x: share(of: line) / totalShare, anchor: .leading)
                                    }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .gridColumnAlignment(.leading)
                            .padding(.vertical, Spacing.s)
                            .onGeometryChange(for: CGRect.self) { proxy in
                                proxy.frame(in: .named(Self.space))
                            } action: { frame in
                                rowFrames[line.id] = frame
                            }
                            Text(UsageFormat.tokens(line.input))
                            Text(UsageFormat.tokens(line.cacheRead))
                            Text(UsageFormat.tokens(line.output))
                            Text(UsageFormat.tokens(line.processed))
                                .foregroundStyle(mode == .tokens ? Theme.textPrimary : Theme.textSecondary)
                            Text(line.priced ? UsageFormat.usd(line.cost) : tr("sem preço"))
                                .foregroundStyle(mode == .cost ? Theme.textPrimary : Theme.textSecondary)
                        }
                        .lineLimit(1)
                        .font(TypeScale.rowSubtitle.monospacedDigit())
                        .foregroundStyle(Theme.textSecondary)
                    }
                }
                .coordinateSpace(.named(Self.space))
                .background(alignment: .topLeading) {
                    if let hoveredLine, let frame = rowFrames[hoveredLine] {
                        RoundedRectangle(cornerRadius: Radius.small, style: .continuous)
                            .fill(Theme.hover)
                            .frame(maxWidth: .infinity)
                            .frame(height: frame.height)
                            .padding(.horizontal, -Spacing.s)
                            .offset(y: frame.minY)
                            .allowsHitTesting(false)
                    }
                }
                .onContinuousHover(coordinateSpace: .named(Self.space)) { phase in
                    switch phase {
                    case .active(let location):
                        hoveredLine = rowFrames.first { $0.value.minY <= location.y && location.y < $0.value.maxY }?.key
                    case .ended:
                        hoveredLine = nil
                    }
                }
                if lines.isEmpty {
                    Text("Sem uso neste período.")
                        .font(TypeScale.caption)
                        .foregroundStyle(Theme.textTertiary)
                }
            }
        }
    }

    private func share(of line: DetailLine) -> Double {
        mode == .cost ? line.cost : line.processed
    }
}
