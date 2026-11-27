@preconcurrency import ConvexMobile
import Foundation
import Observation

/// Sign-in as far as docs/06 §4 defines it, without choosing a provider.
///
/// The identity provider (Auth0, Clerk, ...) is an open owner decision
/// (docs/17 §5). Until one is configured, the app uses
/// `UnconfiguredAuthProvider` and says plainly that sign-in isn't available.
/// It never pretends to be signed in and never holds a backend admin key.
protocol AuthSession: Sendable {
    /// False when this build has no identity provider configured.
    var isConfigured: Bool { get }
    /// Restores a cached session without UI. Returns true when signed in.
    func restore() async -> Bool
    /// Runs the provider's sign-in flow.
    func signIn() async throws
    func signOut() async
}

enum SessionState: Equatable {
    /// Restoring a cached session. Show a real loading state (docs/06 §4).
    case restoring
    case signedIn
    case signedOut(SignedOutReason)
}

enum SignedOutReason: Equatable {
    case notSignedIn
    /// No identity provider is configured in this build.
    case signInUnavailable
}

/// Owns identity state for the process (docs/06 §6). Tracking views appear
/// only while `.signedIn`, so signing out tears down their subscriptions and
/// drops protected data with them.
@MainActor
@Observable
final class SessionStore {
    private(set) var state: SessionState = .restoring
    private(set) var signInError: String?
    private let auth: any AuthSession

    init(auth: any AuthSession) {
        self.auth = auth
    }

    func restore() async {
        guard auth.isConfigured else {
            state = .signedOut(.signInUnavailable)
            return
        }
        state = .restoring
        state = await auth.restore() ? .signedIn : .signedOut(.notSignedIn)
    }

    func signIn() async {
        guard auth.isConfigured else {
            state = .signedOut(.signInUnavailable)
            return
        }
        signInError = nil
        do {
            try await auth.signIn()
            state = .signedIn
        } catch {
            signInError = "Sign-in didn't finish. Try again."
            state = .signedOut(.notSignedIn)
        }
    }

    func signOut() async {
        await auth.signOut()
        state = .signedOut(.notSignedIn)
    }
}

/// `AuthSession` over a `ConvexClientWithAuth`, which passes the provider's ID
/// token to Convex so each function can resolve the caller (docs/11 §1).
///
/// `@unchecked Sendable`: the wrapped client serializes its own auth state
/// (see ConvexMobile's `AuthSession`); this type stores nothing mutable.
final class ConvexAuthSession<Result>: AuthSession, @unchecked Sendable {
    let isConfigured: Bool
    private let client: ConvexClientWithAuth<Result>

    init(client: ConvexClientWithAuth<Result>, isConfigured: Bool) {
        self.client = client
        self.isConfigured = isConfigured
    }

    func restore() async -> Bool {
        if case .success = await client.loginFromCache() { return true }
        return false
    }

    func signIn() async throws {
        if case let .failure(error) = await client.login() { throw error }
    }

    func signOut() async {
        await client.logout()
    }
}

/// Placeholder until the owner chooses an identity provider. Every sign-in
/// attempt fails, so the client stays unauthenticated and the backend
/// returns `access_unavailable` for every tracking query.
struct UnconfiguredAuthProvider: AuthProvider {
    struct NotConfigured: Error {}

    func login(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> String {
        throw NotConfigured()
    }

    func loginFromCache(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> String {
        throw NotConfigured()
    }

    func logout() async throws {}

    func extractIdToken(from authResult: String) -> String { authResult }
}
