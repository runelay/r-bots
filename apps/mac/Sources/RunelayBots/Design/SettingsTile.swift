import SwiftUI

enum SettingsTint {
    static let blue = Color(red: 0.04, green: 0.48, blue: 0.98)
    static let graphite = Color(red: 0.46, green: 0.47, blue: 0.5)
    static let slate = Color(red: 0.2, green: 0.21, blue: 0.24)
    static let red = Color(red: 0.96, green: 0.27, blue: 0.27)
    static let orange = Color(red: 0.98, green: 0.52, blue: 0.13)
    static let purple = Color(red: 0.6, green: 0.36, blue: 0.93)
    static let green = Color(red: 0.2, green: 0.74, blue: 0.4)
    static let teal = Color(red: 0.1, green: 0.68, blue: 0.78)
    static let indigo = Color(red: 0.36, green: 0.38, blue: 0.94)
    static let amber = Color(red: 0.95, green: 0.65, blue: 0.1)
    static let pink = Color(red: 0.93, green: 0.3, blue: 0.55)
}

struct SettingsTile: View {
    let symbol: String
    let color: Color
    var size: CGFloat = 20

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.52, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(color.gradient, in: RoundedRectangle(cornerRadius: size * 0.27, style: .continuous))
            .shadow(color: Theme.elevationShadow, radius: 1, y: 0.5)
            .accessibilityHidden(true)
    }
}
