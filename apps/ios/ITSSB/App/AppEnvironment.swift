@preconcurrency import ConvexMobile
import Foundation

/// Long-lived dependencies, built once per process (docs/06 §3, §8: one
/// Convex client for the process).
@MainActor
struct AppEnvironment {
    let session: SessionStore
    let source: any LiveRunSource
    var initialTab: AppTab = .track

    static func make(configuration: AppConfiguration = .fromBundle(),
                     arguments: [String] = ProcessInfo.processInfo.arguments) -> AppEnvironment {
        #if DEBUG
        if let preview = previewEnvironment(arguments: arguments) { return preview }
        #endif
        let deploymentUrl = configuration.convexURL?.absoluteString ?? "http://127.0.0.1:1"
        guard let publishableKey = configuration.clerkPublishableKey else {
            // No Clerk key in this build: say sign-in isn't set up; never call Clerk.
            let client = ConvexClientWithAuth(deploymentUrl: deploymentUrl, authProvider: UnconfiguredAuthProvider())
            return AppEnvironment(session: SessionStore(auth: UnconfiguredAuthSession()),
                                  source: ConvexLiveRunSource(client: ConvexClientQuerying(client: client)))
        }
        let backend = ClerkSDKBackend(publishableKey: publishableKey)
        let client = ConvexClientWithAuth(deploymentUrl: deploymentUrl,
                                          authProvider: ClerkConvexTokenProvider { backend })
        let querying = ConvexClientQuerying(client: client)
        let auth = ClerkAuthSession(backend: backend, convex: ConvexClientAuth(client: client, querying: querying),
                                    marker: DefaultsSignOutMarker())
        return AppEnvironment(session: SessionStore(auth: auth), source: ConvexLiveRunSource(client: querying))
    }

    #if DEBUG
    /// `-ITSSBScenario stale` launches with fictional tracking data for that screen state;
    /// `-ITSSBAuthScenario signInCode` launches on that sign-in state.
    static func scenario(from arguments: [String]) -> PreviewScenario? {
        value(after: "-ITSSBScenario", in: arguments).flatMap(PreviewScenario.init(rawValue:))
    }

    static func authScenario(from arguments: [String]) -> PreviewAuthScenario? {
        value(after: "-ITSSBAuthScenario", in: arguments).flatMap(PreviewAuthScenario.init(rawValue:))
    }

    private static func value(after flag: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
        return arguments[index + 1]
    }

    private static func previewEnvironment(arguments: [String]) -> AppEnvironment? {
        if let auth = authScenario(from: arguments) {
            let session = SessionStore(auth: PreviewAuthSession(configured: auth != .notConfigured))
            auth.apply(to: session)
            return AppEnvironment(session: session, source: PreviewLiveRunSource(scenario: .live),
                                  initialTab: auth == .account ? .account : .track)
        }
        if let scenario = scenario(from: arguments) {
            return AppEnvironment(session: SessionStore(auth: PreviewAuthSession()),
                                  source: PreviewLiveRunSource(scenario: scenario))
        }
        return nil
    }
    #endif
}

/// The session when no identity provider is configured in this build.
@MainActor
final class UnconfiguredAuthSession: AuthSession {
    let isConfigured = false
    var accountLabel: String? { nil }
    func restore() async throws -> Bool { false }
    func sendEmailCode(to email: String) async throws { throw AuthError.notConfigured }
    func resendEmailCode() async throws { throw AuthError.notConfigured }
    func verifyEmailCode(_ code: String) async throws { throw AuthError.notConfigured }
    func signInWithApple() async throws { throw AuthError.notConfigured }
    func signOut() async {}
}

/// Convex auth provider for a build without sign-in: every attempt fails, so the
/// client stays unauthenticated and the backend returns `access_unavailable`.
struct UnconfiguredAuthProvider: AuthProvider {
    struct NotConfigured: Error {}

    func login(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> String { throw NotConfigured() }
    func loginFromCache(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> String {
        throw NotConfigured()
    }
    func logout() async throws {}
    func extractIdToken(from authResult: String) -> String { authResult }
}

#if DEBUG
/// For previews and scenario screenshots only: every call succeeds instantly.
@MainActor
final class PreviewAuthSession: AuthSession {
    let isConfigured: Bool
    var accountLabel: String? { "sam.example@example.com" }

    init(configured: Bool = true) {
        isConfigured = configured
    }

    func restore() async throws -> Bool { true }
    func sendEmailCode(to email: String) async throws {}
    func resendEmailCode() async throws {}
    func verifyEmailCode(_ code: String) async throws {}
    func signInWithApple() async throws {}
    func signOut() async {}
}

/// Each sign-in screen state, for previews and `-ITSSBAuthScenario` screenshots.
enum PreviewAuthScenario: String, CaseIterable {
    case notConfigured
    case restoring
    case restoreFailed
    case email
    case emailInvalid
    case sending
    case code
    case codeWrong
    case trackingRejected
    case account

    @MainActor
    func apply(to session: SessionStore) {
        let code = SignInStep.code(email: "sam.example@example.com")
        switch self {
        case .notConfigured: session.preset(state: .signedOut(.signInUnavailable))
        case .restoring: session.preset(state: .restoring)
        case .restoreFailed: session.preset(state: .restoreFailed)
        case .email: session.preset(state: .signedOut(.notSignedIn))
        case .emailInvalid: session.preset(state: .signedOut(.notSignedIn), message: .invalidEmail)
        case .sending: session.preset(state: .signedOut(.notSignedIn), isWorking: true)
        case .code: session.preset(state: .signedOut(.notSignedIn), step: code, resendIn: 24)
        case .codeWrong: session.preset(state: .signedOut(.notSignedIn), step: code, message: .invalidCode, resendIn: 0)
        case .trackingRejected: session.preset(state: .signedOut(.notSignedIn), message: .trackingRejected)
        case .account: session.preset(state: .signedIn)
        }
    }
}
#endif
