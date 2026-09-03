// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SymSyncCore",
    platforms: [.macOS(.v15)],
    products: [
        .library(name: "SymSyncCore", targets: ["SymSyncCore"])
    ],
    targets: [
        .target(name: "SymSyncCore"),
        .testTarget(name: "SymSyncCoreTests", dependencies: ["SymSyncCore"]),
    ]
)
