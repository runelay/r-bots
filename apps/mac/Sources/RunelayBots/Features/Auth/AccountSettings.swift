import SwiftUI

struct AccountSettingsGroup: View {
    private let session = AuthSession.shared
    @State private var leaving = false

    var body: some View {
        if let user = session.user {
            SettingsGroup(caption: "Conta") {
                SettingsRow(title: user.name, detail: user.isOwner ? "\(user.email) · dono" : user.email) {
                    Button {
                        leaving = true
                        Task {
                            await session.signOut()
                            leaving = false
                        }
                    } label: {
                        HStack(spacing: Spacing.xs + 2) {
                            if leaving {
                                ProgressView()
                                    .controlSize(.small)
                            }
                            Text("Sair")
                                .lineLimit(1)
                                .fixedSize()
                        }
                    }
                    .buttonStyle(.brandSecondary)
                    .disabled(leaving)
                }
            }
        }
    }
}
