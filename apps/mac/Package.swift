// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "RunelayBots",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "RunelayBots", targets: ["RunelayBots"])
    ],
    targets: [
        .executableTarget(
            name: "RunelayBots",
            path: "Sources/RunelayBots",
            resources: [
                .copy("Resources/Fonts"),
                .copy("Resources/Logos"),
            ]
        ),
        .testTarget(
            name: "RunelayBotsTests",
            dependencies: ["RunelayBots"],
            path: "Tests/RunelayBotsTests"
        ),
    ],
    swiftLanguageModes: [.v6]
)
