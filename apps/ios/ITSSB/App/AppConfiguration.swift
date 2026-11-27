import Foundation

/// Public, per-build configuration (docs/06 §2). Values come from
/// `Config/*.xcconfig` through Info.plist; the real deployment URL lives in the
/// gitignored `Config/Secrets.xcconfig`. Nothing here is a secret: the app
/// never holds an admin key.
struct AppConfiguration: Equatable {
    let convexURL: URL?

    static func fromBundle(_ bundle: Bundle = .main) -> AppConfiguration {
        AppConfiguration(convexURL: (bundle.object(forInfoDictionaryKey: "ConvexURL") as? String)
            .flatMap(URL.init(string:)))
    }

    /// True when the build still points at the fail-fast placeholder (127.0.0.1:1).
    var isPlaceholder: Bool {
        guard let host = convexURL?.host() else { return true }
        return host == "127.0.0.1" || host == "localhost"
    }
}
