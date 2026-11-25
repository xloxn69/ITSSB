// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "ITSSBDesignSystem",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "ITSSBDesignSystem", targets: ["ITSSBDesignSystem"])
    ],
    targets: [
        .target(name: "ITSSBDesignSystem"),
        .testTarget(name: "ITSSBDesignSystemTests", dependencies: ["ITSSBDesignSystem"])
    ]
)
