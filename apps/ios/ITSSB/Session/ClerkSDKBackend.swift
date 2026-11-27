import AuthenticationServices
import ClerkKit
import Foundation

/// `ClerkBackend` over the Clerk iOS SDK (ClerkKit 1.7.5). Kept thin: every
/// decision lives in `ClerkAuthSession` and `SessionStore`, which are tested
/// with a fake. Only created when a valid publishable key is configured.
@MainActor
final class ClerkSDKBackend: ClerkBackend {
    private enum Pending {
        case signIn(SignIn)
        case signUp(SignUp)
    }

    private var pending: Pending?
    private var clerk: Clerk { Clerk.shared }

    init(publishableKey: String) {
        Clerk.configure(publishableKey: publishableKey)
    }

    func waitUntilLoaded(timeout: Duration) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while !clerk.isLoaded {
            guard ContinuousClock.now < deadline else { return false }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return true
    }

    var hasActiveSession: Bool { clerk.session?.status == .active }

    var accountLabel: String? { clerk.user?.primaryEmailAddress?.emailAddress }

    func startEmailCode(_ email: String) async throws {
        do {
            pending = .signIn(try await clerk.auth.signInWithEmailCode(emailAddress: email))
        } catch let error as ClerkAPIError where error.code == "form_identifier_not_found" {
            // First sign-in for this address: create the identity so staff can link it later.
            let signUp = try await mapped { try await self.clerk.auth.signUp(emailAddress: email) }
            pending = .signUp(try await mapped { try await signUp.sendEmailCode() })
        } catch {
            throw Self.authError(for: error)
        }
    }

    func resendEmailCode() async throws {
        switch pending {
        case .signIn(let signIn): pending = .signIn(try await mapped { try await signIn.sendEmailCode() })
        case .signUp(let signUp): pending = .signUp(try await mapped { try await signUp.sendEmailCode() })
        case nil: throw AuthError.failed
        }
    }

    func verifyEmailCode(_ code: String) async throws -> Bool {
        let sessionId: String?
        switch pending {
        case .signIn(let signIn): sessionId = try await mapped { try await signIn.verifyCode(code) }.createdSessionId
        case .signUp(let signUp):
            sessionId = try await mapped { try await signUp.verifyEmailCode(code) }.createdSessionId
        case nil: throw AuthError.failed
        }
        return try await activate(sessionId)
    }

    func signInWithApple() async throws -> Bool {
        let result = try await mapped { try await self.clerk.auth.signInWithApple() }
        switch result {
        case .signIn(let signIn): return try await activate(signIn.createdSessionId)
        case .signUp(let signUp): return try await activate(signUp.createdSessionId)
        }
    }

    func signOut() async throws {
        pending = nil
        try await mapped { try await self.clerk.auth.signOut() }
    }

    func convexToken() async throws -> String? {
        try await mapped { try await self.clerk.auth.getToken(.init(template: "convex", expirationBuffer: 30)) }
    }

    // MARK: Private

    private func activate(_ sessionId: String?) async throws -> Bool {
        guard let sessionId else { return false }
        pending = nil
        if clerk.session?.id != sessionId {
            try await mapped { try await self.clerk.auth.setActive(sessionId: sessionId) }
        }
        return hasActiveSession
    }

    /// Runs a Clerk call and converts its failure into an `AuthError`.
    private func mapped<Value>(_ call: () async throws -> Value) async throws -> Value {
        do {
            return try await call()
        } catch {
            throw Self.authError(for: error)
        }
    }

    nonisolated static func authError(for error: Error) -> AuthError {
        if let apiError = error as? ClerkAPIError { return authError(forCode: apiError.code) }
        if let appleError = error as? ASAuthorizationError, appleError.code == .canceled { return .cancelled }
        if error is URLError { return .network }
        return .failed
    }

    /// Clerk API error codes the sign-in screens explain.
    nonisolated static func authError(forCode code: String) -> AuthError {
        switch code {
        case "form_identifier_not_found", "form_param_format_invalid", "form_param_nil": .invalidEmail
        case "form_code_incorrect", "verification_failed": .invalidCode
        case "verification_expired": .codeExpired
        case "too_many_requests", "rate_limit_exceeded", "too_many_attempts": .tooManyAttempts
        default: .failed
        }
    }
}
