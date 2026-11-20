import SwiftUI

struct MicrophonePicker: View {
    var onSelect: (Microphone?) -> Void = { _ in }
    private let catalog = MicrophoneCatalog.shared
    @State private var meter = MicrophoneMeter()

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Microfone")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.textPrimary)
                .padding(.bottom, 2)
            if let lost = catalog.lostName {
                Text(Microphones.lostNotice(lost))
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, 2)
            }
            row(nil, title: "Padrão do sistema", detail: catalog.systemName.isEmpty ? nil : catalog.systemName)
            ForEach(catalog.devices) { microphone in
                row(microphone, title: microphone.name, detail: nil)
            }
            Text("Fale algo: a barra do microfone escolhido tem que mexer.")
                .font(.system(size: 11))
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 2)
        }
        .onAppear {
            catalog.reload()
            meter.watch(selected)
        }
        .onDisappear {
            meter.stop()
        }
    }

    private var selected: Microphone? {
        catalog.devices.first { $0.uid == catalog.selectedUID }
    }

    private func row(_ microphone: Microphone?, title: String, detail: String?) -> some View {
        let isSelected = microphone?.uid == catalog.selectedUID
        return Button {
            guard !isSelected else { return }
            catalog.select(microphone)
            meter.watch(microphone)
            onSelect(microphone)
        } label: {
            HStack(spacing: Spacing.s) {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 12))
                    .foregroundStyle(isSelected ? Theme.brandAccent : Theme.textTertiary)
                VStack(alignment: .leading, spacing: 0) {
                    Text(title)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    if let detail {
                        Text(detail)
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: Spacing.s)
                if isSelected {
                    MicrophoneLevelBar(meter: meter)
                        .transition(.opacity)
                }
            }
            .padding(.vertical, 3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickable()
        .accessibilityLabel(isSelected ? "\(title), escolhido" : title)
    }
}

struct MicrophoneLevelBar: View {
    let meter: MicrophoneMeter
    var width: CGFloat = 56
    var isActive = true

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20, paused: !isActive || !AppActivity.shared.isLive)) { _ in
            let value = isActive ? MicrophoneMeter.display(meter.level) : 0
            Capsule()
                .fill(Theme.hover)
                .frame(width: width, height: 6)
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(Theme.brandAccent)
                        .frame(width: max(6, width * value), height: 6)
                }
        }
        .accessibilityHidden(true)
    }
}

struct MicrophoneSettingRow: View {
    var onSelect: () -> Void = {}
    private let catalog = MicrophoneCatalog.shared
    @State private var meter = MicrophoneMeter()
    @State private var isVisible = false
    var body: some View {
        SettingsRow(
            title: "Microfone",
            icon: SettingsIcon("mic.fill", SettingsTint.red),
            detail: catalog.lostName.map(Microphones.lostNotice),
            info: "Fale algo: a barra do microfone escolhido tem que mexer."
        ) {
            HStack(spacing: Spacing.m) {
                MicrophoneLevelBar(meter: meter, width: 64, isActive: isVisible)
                menu
            }
        }
        .onAppear {
            isVisible = true
            catalog.reload()
            meter.watch(selected)
        }
        .onDisappear {
            isVisible = false
            meter.stop()
        }
        .onChange(of: catalog.devices.map(\.uid)) {
            guard isVisible else { return }
            meter.watch(selected)
        }
        .onChange(of: catalog.systemName) {
            guard isVisible, catalog.selectedUID == nil else { return }
            meter.watch(nil)
        }
    }

    private var selected: Microphone? {
        catalog.devices.first { $0.uid == catalog.selectedUID }
    }

    private var systemTitle: String {
        catalog.systemName.isEmpty ? "Padrão do sistema" : "Padrão do sistema (\(catalog.systemName))"
    }

    private var currentTitle: String {
        selected?.name ?? systemTitle
    }

    private var menu: some View {
        GlassSelect(
            options: [GlassSelectOption(systemTitle, value: String?.none)]
                + catalog.devices.enumerated().map { index, microphone in
                    GlassSelectOption(microphone.name, value: Optional(microphone.uid), startsSection: index == 0)
                },
            selection: Binding(
                get: { catalog.selectedUID },
                set: { uid in
                    guard uid != catalog.selectedUID else { return }
                    let microphone = catalog.devices.first { $0.uid == uid }
                    catalog.select(microphone)
                    meter.watch(microphone)
                    onSelect()
                }
            ),
            title: currentTitle,
            help: "Escolher o microfone",
            maxWidth: 240,
            edge: .trailing
        )
        .accessibilityLabel("Microfone")
    }
}
