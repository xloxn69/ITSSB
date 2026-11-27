import Foundation

/// Public, per-build configuration (docs/06 §2). Values come from
/// `Config/*.xcconfig` through Info.plist; real values live in the gitignored
/// `Config/Secrets.xcconfig`. Nothing here is a secret: the Clerk publishable
/// key is meant for clients, and the app never holds an admin or secret key.
struct AppConfiguration: Equatable {
    let convexURL: URL?
    /// A well-formed Clerk publishable key, or nil (sign-in not configured).
    let clerkPublishableKey: String?

    init(convexURL: URL?, clerkPublishableKey: String? = nil) {
        self.convexURL = convexURL
        self.clerkPublishableKey = clerkPublishableKey.flatMap(Self.validClerkKey)
    }

    static func fromBundle(_ bundle: Bundle = .main,
                           environment: [String: String] = ProcessInfo.processInfo.environment) -> AppConfiguration {
        // Unit tests must never reach Clerk, even when a developer's Secrets.xcconfig has a key.
        let underTest = environment["XCTestConfigurationFilePath"] != nil
        return AppConfiguration(
            convexURL: (bundle.object(forInfoDictionaryKey: "ConvexURL") as? String).flatMap(URL.init(string:)),
            clerkPublishableKey: underTest ? nil : bundle.object(forInfoDictionaryKey: "ClerkPublishableKey") as? String
        )
    }

    /// True when the build still points at the fail-fast placeholder (127.0.0.1:1).
    var isPlaceholder: Bool {
        guard let host = convexURL?.host() else { return true }
        return host == "127.0.0.1" || host == "localhost"
    }

    /// Accepts `pk_test_…`/`pk_live_…` whose payload is base64 of `<frontend-api-host>$`, the
    /// format Clerk issues. Placeholders are rejected so `Clerk.configure` never sees a bad key.
    static func validClerkKey(_ raw: String) -> String? {
        let key = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let prefix = ["pk_test_", "pk_live_"].first(where: key.hasPrefix) else { return nil }
        var payload = String(key.dropFirst(prefix.count))
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let data = Data(base64Encoded: payload),
              let decoded = String(data: data, encoding: .utf8),
              decoded.hasSuffix("$"), decoded.dropLast().contains(".") else { return nil }
        return key
    }
}
