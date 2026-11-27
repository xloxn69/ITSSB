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

/// `AuthSession` over Clerk, with the Convex client authenticated by the
/// Clerk token (docs/06 §4, backend `auth.config.ts`).
@MainActor
final class ClerkAuthSession: AuthSession {
    let isConfigured = true
    private let backend: any ClerkBackend
    private let convex: any ConvexAuthControlling
    static let loadTimeout: Duration = .seconds(10)

    init(backend: any ClerkBackend, convex: any ConvexAuthControlling) {
        self.backend = backend
        self.convex = convex
    }

    var accountLabel: String? { backend.accountLabel }

    func restore() async throws -> Bool {
        guard await backend.waitUntilLoaded(timeout: Self.loadTimeout) else { throw AuthError.network }
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
        try await authenticateConvex()
    }

    func signInWithApple() async throws {
        guard try await backend.signInWithApple() else { throw AuthError.needsMoreInfo }
        try await authenticateConvex()
    }

    func signOut() async {
        await convex.logout()
        try? await backend.signOut()
    }

    /// Signed in with Clerk; now Convex must accept the token. If it doesn't, sign out of
    /// Clerk too, so the app never sits "signed in" while every query says signed out.
    private func authenticateConvex() async throws {
        guard await convex.login() else {
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

    init(refreshInterval: Duration = .seconds(20), backend: @escaping @MainActor () -> any ClerkBackend) {
        self.refreshInterval = refreshInterval
        self.backend = backend
    }

    func login(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> String {
        try await token(onIdToken: onIdToken)
    }

    func loginFromCache(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> String {
        try await token(onIdToken: onIdToken)
    }

    func logout() async throws {
        await MainActor.run { stopRefreshing() }
    }

    func extractIdToken(from authResult: String) -> String { authResult }

    @MainActor
    private func token(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> String {
        guard let token = try await backend().convexToken() else { throw NoSession() }
        startRefreshing(onIdToken: onIdToken)
        return token
    }

    @MainActor
    private func startRefreshing(onIdToken: @Sendable @escaping (String?) -> Void) {
        refreshTask?.cancel()
        let interval = refreshInterval
        let backend = backend
        refreshTask = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: interval)
                guard !Task.isCancelled else { return }
                do {
                    guard let token = try await backend().convexToken() else {
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
        refreshTask?.cancel()
        refreshTask = nil
    }
}
