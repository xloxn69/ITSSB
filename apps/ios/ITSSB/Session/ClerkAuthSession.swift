@preconcurrency import ConvexMobile
import Foundation

/// The Clerk operations the app uses. `ClerkSDKBackend` calls the real SDK;
/// tests use a fake, so they never reach the network.
@MainActor
protocol ClerkBackend: AnyObject {
    /// Waits for Clerk to load its cached client. False on timeout (offline).
    func waitUntilLoaded(timeout: Duration) async -> Bool
    var hasActiveSession: Bool { get }
    var accountLabel: String? { get }
    /// Starts an email-code sign-in, or a sign-up when the address is new, and sends the code.
    func startEmailCode(_ email: String) async throws
    func resendEmailCode() async throws
    /// Verifies the code. Returns true when it produced an active session.
    func verifyEmailCode(_ code: String) async throws -> Bool
    /// Runs Sign in with Apple. Returns true when it produced an active session.
    func signInWithApple() async throws -> Bool
    func signOut() async throws
    /// A token from the `convex` JWT template, or nil without an active session.
    func convexToken() async throws -> String?
}

/// Remembers, on this phone, that the person signed out. Clerk clears its
/// stored session only after its sign-out request succeeds, so an offline
/// sign-out would otherwise come back on the next online launch.
@MainActor
protocol SignOutMarker: AnyObject {
    var isSignedOut: Bool { get set }
}

/// `SignOutMarker` in UserDefaults. It is a flag, not a credential.
@MainActor
final class DefaultsSignOutMarker: SignOutMarker {
    private let defaults: UserDefaults
    private let key = "itssb.signedOutPendingClerk"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var isSignedOut: Bool {
        get { defaults.bool(forKey: key) }
        set { defaults.set(newValue, forKey: key) }
    }
}

/// `AuthSession` over Clerk, with the Convex client authenticated by the
/// Clerk token (docs/06 §4, backend `auth.config.ts`).
@MainActor
final class ClerkAuthSession: AuthSession {
    let isConfigured = true
    private let backend: any ClerkBackend
    private let convex: any ConvexAuthControlling
    private let marker: any SignOutMarker
    static let loadTimeout: Duration = .seconds(10)

    init(backend: any ClerkBackend, convex: any ConvexAuthControlling, marker: any SignOutMarker) {
        self.backend = backend
        self.convex = convex
        self.marker = marker
    }

    var accountLabel: String? { backend.accountLabel }

    func restore() async throws -> Bool {
        guard await backend.waitUntilLoaded(timeout: Self.loadTimeout) else { throw AuthError.network }
        if marker.isSignedOut {
            // A sign-out that didn't reach Clerk: finish it now, and never restore that session.
            if backend.hasActiveSession { try? await backend.signOut() }
            if !backend.hasActiveSession { marker.isSignedOut = false }
            return false
        }
        guard backend.hasActiveSession else { return false }
        try await authenticateConvex()
        return true
    }

    func sendEmailCode(to email: String) async throws {
        try await backend.startEmailCode(email)
    }

    func resendEmailCode() async throws {
        try await backend.resendEmailCode()
    }

    func verifyEmailCode(_ code: String) async throws {
        guard try await backend.verifyEmailCode(code) else { throw AuthError.needsMoreInfo }
        marker.isSignedOut = false
        try await authenticateConvex()
    }

    func signInWithApple() async throws {
        guard try await backend.signInWithApple() else { throw AuthError.needsMoreInfo }
        marker.isSignedOut = false
        try await authenticateConvex()
    }

    func signOut() async {
        // Mark first: if Clerk can't be reached, the next launch still treats this phone as signed out.
        marker.isSignedOut = true
        await convex.logout()
        try? await backend.signOut()
        if !backend.hasActiveSession { marker.isSignedOut = false }
    }

    /// Signed in with Clerk; now the backend must recognize the identity.
    /// - Rejected (the backend answers as if no one signed in): sign out of Clerk too, so the
    ///   app never sits "signed in" while every query says signed out.
    /// - Unreachable: keep the Clerk session and report a retryable connection problem.
    private func authenticateConvex() async throws {
        switch await convex.login() {
        case .accepted:
            return
        case .unreachable:
            await convex.logout()
            throw AuthError.trackingUnreachable
        case .rejected:
            await convex.logout()
            try? await backend.signOut()
            throw AuthError.trackingRejected
        }
    }
}

/// ConvexMobile `AuthProvider` that supplies Clerk tokens from the `convex` JWT
/// template (the backend's `applicationID`). Clerk tokens live about a minute,
/// so while authenticated it pushes a fresh token every `refreshInterval`
/// rather than waiting for the old one to expire.
final class ClerkConvexTokenProvider: AuthProvider, @unchecked Sendable {
    // @unchecked Sendable: `refreshTask` is only touched on the main actor (see `startRefreshing`).
    // ConvexMobile's associated type name.
    typealias T = String // swiftlint:disable:this type_name

    struct NoSession: Error {}

    private let backend: @MainActor () -> any ClerkBackend
    private let refreshInterval: Duration
    @MainActor private var refreshTask: Task<Void, Never>?
    /// Bumped on logout. A token fetched for an older generation is never used or pushed,
    /// so a late result can't sign the next person in as the previous one.
    @MainActor private var generation = 0
    /// How many times ConvexMobile has forced a token refresh. It does that after the server
    /// rejects a token (it reconnects and calls `loginFromCache`), so a forced refresh right
    /// after a fresh login is the sign that the backend refused the token.
    @MainActor private(set) var forcedRefreshes = 0

    init(refreshInterval: Duration = .seconds(20), backend: @escaping @MainActor () -> any ClerkBackend) {
        self.refreshInterval = refreshInterval
        self.backend = backend
    }

    func login(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> String {
        try await token(onIdToken: onIdToken)
    }

    func loginFromCache(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> String {
        await MainActor.run { forcedRefreshes += 1 }
        return try await token(onIdToken: onIdToken)
    }

    func logout() async throws {
        await MainActor.run { stopRefreshing() }
    }

    func extractIdToken(from authResult: String) -> String { authResult }

    @MainActor
    private func token(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> String {
        let current = generation
        let token = try await backend().convexToken()
        guard current == generation, let token else { throw NoSession() }
        startRefreshing(onIdToken: onIdToken)
        return token
    }

    @MainActor
    private func startRefreshing(onIdToken: @Sendable @escaping (String?) -> Void) {
        refreshTask?.cancel()
        let interval = refreshInterval
        let backend = backend
        let current = generation
        refreshTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: interval)
                do {
                    let token = try await backend().convexToken()
                    // Logged out (or restarted) while fetching: drop this result.
                    guard !Task.isCancelled, let self, self.generation == current else { return }
                    guard let token else {
                        onIdToken(nil) // Signed out elsewhere: Convex drops the identity.
                        return
                    }
                    onIdToken(token)
                } catch {
                    continue // Offline: keep the current token; Convex re-asks when it expires.
                }
            }
        }
    }

    @MainActor
    private func stopRefreshing() {
        generation += 1
        refreshTask?.cancel()
        refreshTask = nil
    }
}
