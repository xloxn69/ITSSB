@preconcurrency import ConvexMobile
import Foundation
import UIKit

/// Long-lived dependencies, built once per process (docs/06 §3, §8: one
/// Convex client for the process).
@MainActor
struct AppEnvironment {
    let session: SessionStore
    let source: any LiveRunSource
    let notifications: any NotificationSource
    /// Nil without sign-in and in fixture mode: screenshots never touch OS notification settings.
    var registrar: PushRegistrar?
    var initialTab: AppTab = .track
    /// Join a route, link a student, check in (docs/09). Nil only in previews that don't need it.
    var enrollment: (any EnrollmentSource)?
    #if DEBUG
    var enrollmentScreen: FamilyScreen?
    #endif

    static func make(configuration: AppConfiguration = .fromBundle(),
                     arguments: [String] = ProcessInfo.processInfo.arguments) -> AppEnvironment {
        #if DEBUG
        if let preview = previewEnvironment(arguments: arguments) { return preview }
        #endif
        let deploymentUrl = configuration.convexURL?.absoluteString ?? "http://127.0.0.1:1"
        guard let publishableKey = configuration.clerkPublishableKey else {
            // No Clerk key in this build: say sign-in isn't set up; never call Clerk.
            let client = ConvexClientWithAuth(deploymentUrl: deploymentUrl, authProvider: UnconfiguredAuthProvider())
            let querying = ConvexClientQuerying(client: client)
            return AppEnvironment(session: SessionStore(auth: UnconfiguredAuthSession()),
                                  source: ConvexLiveRunSource(client: querying),
                                  notifications: ConvexNotificationSource(queries: querying, commands: querying),
                                  enrollment: ConvexEnrollmentSource(client: client))
        }
        let backend = ClerkSDKBackend(publishableKey: publishableKey)
        let provider = ClerkConvexTokenProvider { backend }
        let client = ConvexClientWithAuth(deploymentUrl: deploymentUrl, authProvider: provider)
        let querying = ConvexClientQuerying(client: client)
        let convex = ConvexClientAuth(client: client, querying: querying) { provider.forcedRefreshes }
        let auth = ClerkAuthSession(backend: backend, convex: convex, marker: DefaultsSignOutMarker())
        let notifications = ConvexNotificationSource(queries: querying, commands: querying)
        #if DEBUG
        let pushEnvironment = PushEnvironment.sandbox
        #else
        let pushEnvironment = PushEnvironment.production
        #endif
        let registrar = PushRegistrar(source: notifications, authorizing: SystemPushAuthorizing(),
                                      environment: pushEnvironment) {
            UIApplication.shared.registerForRemoteNotifications()
        }
        let session = SessionStore(auth: auth)
        // While still signed in: drop a pending notification tap and stop this
        // phone receiving the account's pushes.
        session.beforeSignOut = NotificationRouter.signOutCleanup(router: .shared, registrar: registrar)
        return AppEnvironment(session: session, source: ConvexLiveRunSource(client: querying),
                              notifications: notifications, registrar: registrar,
                              enrollment: ConvexEnrollmentSource(client: client))
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
        // `home` opens My Route itself; any other value opens that screen.
        if let name = value(after: "-ITSSBEnrollmentScreen", in: arguments),
           name == "home" || FamilyScreen(rawValue: name) != nil {
            let screen = FamilyScreen(rawValue: name)
            let variant = value(after: "-ITSSBEnrollmentVariant", in: arguments)
                .flatMap(PreviewEnrollmentSource.Variant.init(rawValue:)) ?? .normal
            return AppEnvironment(session: SessionStore(auth: PreviewAuthSession()),
                                  source: PreviewLiveRunSource(scenario: .live),
                                  notifications: PreviewNotificationSource(scenario: .live), initialTab: .route,
                                  enrollment: PreviewEnrollmentSource(variant: variant), enrollmentScreen: screen)
        }
        if let auth = authScenario(from: arguments) {
            let session = SessionStore(auth: PreviewAuthSession(configured: auth != .notConfigured))
            auth.apply(to: session)
            return AppEnvironment(session: session, source: PreviewLiveRunSource(scenario: .live),
                                  notifications: PreviewNotificationSource(scenario: .live),
                                  initialTab: auth == .account ? .account : .track)
        }
        if let scenario = scenario(from: arguments) {
            // `-ITSSBTab alerts` opens on the Alerts tab, for screenshots.
            let tab: AppTab = value(after: "-ITSSBTab", in: arguments) == "alerts" ? .alerts : .track
            return AppEnvironment(session: SessionStore(auth: PreviewAuthSession()),
                                  source: PreviewLiveRunSource(scenario: scenario),
                                  notifications: PreviewNotificationSource(scenario: scenario), initialTab: tab)
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
