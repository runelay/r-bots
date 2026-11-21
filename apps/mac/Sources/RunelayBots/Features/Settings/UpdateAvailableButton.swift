import SwiftUI

struct UpdateCheckKey: Hashable {
    let server: String
    let userID: String?
    let isOwner: Bool
    let paused: Bool
}

struct UpdateAvailableButton: View {
    @Environment(AppModel.self) private var model

    private var count: Int {
        guard AuthSession.shared.user?.isOwner == true else { return 0 }
        return model.versions.updateCount
    }

    private var help: String {
        count == 1 ? "Atualização disponível" : "\(count) atualizações disponíveis"
    }

    var body: some View {
        if count > 0 {
            Button {
                model.openSettings(.versions)
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Theme.onAccent)
                    .frame(width: 24, height: 24)
                    .background(Theme.brandAccent, in: Circle())
                    .frame(width: 28, height: 28)
                    .contentShape(Circle())
            }
            .buttonStyle(PressableButtonStyle())
            .help(help)
            .accessibilityLabel(help)
            .transition(.scale(scale: 0.6).combined(with: .opacity))
        }
    }
}
