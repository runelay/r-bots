import AppKit
import SwiftUI

@MainActor
@Observable
final class UserIdentity {
    static let shared = UserIdentity()

    private(set) var photo: NSImage?
    @ObservationIgnored private var loadedPath: String?
    @ObservationIgnored private var cache: [String: NSImage] = [:]

    private let session = AuthSession.shared

    var displayName: String {
        session.user?.name ?? ""
    }

    var initials: String {
        let words = displayName.split(whereSeparator: { $0.isWhitespace }).filter { !$0.isEmpty }
        let letters = [words.first, words.count > 1 ? words.last : nil].compactMap { $0?.first }
        return letters.isEmpty ? "?" : String(letters).uppercased()
    }

    func refresh() async {
        guard let path = session.user?.image else {
            loadedPath = nil
            photo = nil
            return
        }
        guard path != loadedPath else { return }
        loadedPath = path
        if let cached = cache[path] {
            photo = cached
            return
        }
        guard let data = try? await session.avatarData(path: path), let image = NSImage(data: data) else {
            if loadedPath == path { loadedPath = nil }
            return
        }
        cache[path] = image
        if loadedPath == path { photo = image }
    }

    func show(_ image: NSImage, for path: String?) {
        if let path {
            cache[path] = image
        }
        loadedPath = path
        photo = image
    }
}

struct UserAvatar: View {
    let size: CGFloat
    private let identity = UserIdentity.shared
    private let session = AuthSession.shared

    var body: some View {
        ZStack {
            if let photo = identity.photo {
                Image(nsImage: photo)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFill()
            } else {
                Circle()
                    .fill(Theme.surfaceRaised)
                Text(identity.initials)
                    .font(BrandFonts.sans(size * 0.38, weight: .semibold))
                    .foregroundStyle(Theme.textSecondary)
                    .minimumScaleFactor(0.5)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .task(id: session.user?.image ?? "none") {
            await identity.refresh()
        }
        .accessibilityHidden(true)
    }
}

enum AvatarImage {
    static let side: CGFloat = 512

    static func squareJPEG(from image: NSImage) -> Data? {
        var rect = CGRect(origin: .zero, size: image.size)
        guard let source = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return nil }
        let width = CGFloat(source.width)
        let height = CGFloat(source.height)
        let edge = min(width, height)
        let crop = CGRect(x: (width - edge) / 2, y: (height - edge) / 2, width: edge, height: edge).integral
        guard let square = source.cropping(to: crop) else { return nil }
        let target = Int(min(side, edge))
        guard let context = CGContext(
            data: nil,
            width: target,
            height: target,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ) else { return nil }
        context.interpolationQuality = .high
        context.setFillColor(CGColor.white)
        context.fill(CGRect(x: 0, y: 0, width: target, height: target))
        context.draw(square, in: CGRect(x: 0, y: 0, width: target, height: target))
        guard let scaled = context.makeImage() else { return nil }
        let bitmap = NSBitmapImageRep(cgImage: scaled)
        return bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.86])
    }
}
