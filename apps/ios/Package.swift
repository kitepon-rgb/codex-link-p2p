// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CodexLinkIOS",
    platforms: [
        .iOS(.v16),
        .macOS(.v13),
    ],
    products: [
        .library(name: "CodexLinkIOS", targets: ["CodexLinkIOS"]),
    ],
    dependencies: [
        .package(url: "https://github.com/stasel/WebRTC.git", from: "120.0.0"),
    ],
    targets: [
        .target(
            name: "CodexLinkIOS",
            dependencies: [
                .product(name: "WebRTC", package: "WebRTC"),
            ]
        ),
        .testTarget(
            name: "CodexLinkIOSTests",
            dependencies: ["CodexLinkIOS"]
        ),
    ]
)
