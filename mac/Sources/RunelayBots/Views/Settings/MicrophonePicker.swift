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

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20, paused: !AppActivity.shared.isLive)) { _ in
            let value = MicrophoneMeter.display(meter.level)
            Capsule()
                .fill(Theme.hover)
                .frame(width: 56, height: 6)
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(Theme.brandAccent)
                        .frame(width: max(6, 56 * value), height: 6)
                }
        }
        .accessibilityHidden(true)
    }
}
