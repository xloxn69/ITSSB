import XCTest
@testable import ITSSB

/// A scriptable Clerk. Never reaches the network.
@MainActor
private final class FakeClerk: ClerkBackend {
    var loads = true
    var hasActiveSession = false
    var accountLabel: String? { hasActiveSession ? "sam.example@example.com" : nil }
    var verifyCreatesSession = true
    var appleCreatesSession = true
    var startError: AuthError?
    var verifyError: AuthError?
    var token: String? = "token-1"
    var tokenError: Error?
    private(set) var calls: [String] = []
    private(set) var tokenRequests = 0

    func waitUntilLoaded(timeout: Duration) async -> Bool { loads }
    func startEmailCode(_ email: String) async throws {
        calls.append("start")
        if let startError { throw startError }
    }
    func resendEmailCode() async throws { calls.append("resend") }
    func verifyEmailCode(_ code: String) async throws -> Bool {
        calls.append("verify")
        if let verifyError { throw verifyError }
        hasActiveSession = verifyCreatesSession
        return verifyCreatesSession
    }
    func signInWithApple() async throws -> Bool {
        calls.append("apple")
        hasActiveSession = appleCreatesSession
        return appleCreatesSession
    }
    func signOut() async throws {
        calls.append("signOut")
        hasActiveSession = false
    }
    func convexToken() async throws -> String? {
        tokenRequests += 1
        if let tokenError { throw tokenError }
        return hasActiveSession ? token : nil
    }
}

@MainActor
private final class FakeConvex: ConvexAuthControlling {
    var accepts = true
    private(set) var calls: [String] = []
    func login() async -> Bool {
        calls.append("login")
        return accepts
    }
    func logout() async { calls.append("logout") }
}

@MainActor
final class ClerkAuthSessionTests: XCTestCase {
    private let clerk = FakeClerk()
    private let convex = FakeConvex()
    private lazy var session = ClerkAuthSession(backend: clerk, convex: convex)

    func testRestoreWithoutASessionIsSignedOutAndSkipsConvex() async throws {
        let restored = try await session.restore()
        XCTAssertFalse(restored)
        XCTAssertEqual(convex.calls, [])
    }

    func testRestoreWithASessionAuthenticatesConvex() async throws {
        clerk.hasActiveSession = true
        let restored = try await session.restore()
        XCTAssertTrue(restored)
        XCTAssertEqual(convex.calls, ["login"])
    }

    func testRestoreWhenClerkCannotLoadIsANetworkError() async {
        clerk.loads = false
        do {
            _ = try await session.restore()
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? AuthError, .network)
        }
    }

    func testVerifiedCodeSignsInToClerkThenConvex() async throws {
        try await session.sendEmailCode(to: "sam.example@example.com")
        try await session.verifyEmailCode("123456")
        XCTAssertEqual(clerk.calls, ["start", "verify"])
        XCTAssertEqual(convex.calls, ["login"])
    }

    /// Clerk accepted the person but Convex refused the token (no `convex` template or issuer):
    /// sign out of Clerk too, so the app is never "signed in" while every query says signed out.
    func testConvexRejectingTheTokenSignsOutOfClerk() async {
        convex.accepts = false
        do {
            try await session.verifyEmailCode("123456")
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? AuthError, .trackingRejected)
        }
        XCTAssertTrue(clerk.calls.contains("signOut"))
        XCTAssertFalse(clerk.hasActiveSession)
    }

    func testCodeWithoutASessionNeedsMoreInfo() async {
        clerk.verifyCreatesSession = false
        do {
            try await session.verifyEmailCode("123456")
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? AuthError, .needsMoreInfo)
        }
        XCTAssertEqual(convex.calls, [], "no Convex login without a Clerk session")
    }

    func testAppleWithoutASessionEndsInAnErrorNotASpinner() async {
        clerk.appleCreatesSession = false
        do {
            try await session.signInWithApple()
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? AuthError, .needsMoreInfo)
        }
    }

    func testSignOutLeavesConvexThenClerk() async {
        clerk.hasActiveSession = true
        await session.signOut()
        XCTAssertEqual(convex.calls, ["logout"])
        XCTAssertEqual(clerk.calls, ["signOut"])
    }

    func testClerkErrorsPassThroughUnchanged() async {
        clerk.startError = .tooManyAttempts
        do {
            try await session.sendEmailCode(to: "sam.example@example.com")
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? AuthError, .tooManyAttempts)
        }
    }
}

@MainActor
final class ClerkConvexTokenProviderTests: XCTestCase {
    private final class Pushed: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [String?] = []
        func append(_ value: String?) { lock.withLock { values.append(value) } }
        var all: [String?] { lock.withLock { values } }
    }

    func testLoginUsesTheConvexTemplateTokenAndFailsWithoutASession() async throws {
        let clerk = FakeClerk()
        let provider = ClerkConvexTokenProvider(refreshInterval: .seconds(3600)) { clerk }
        do {
            _ = try await provider.login(onIdToken: { _ in })
            XCTFail("expected no session")
        } catch {
            XCTAssertTrue(error is ClerkConvexTokenProvider.NoSession)
        }
        clerk.hasActiveSession = true
        let token = try await provider.login(onIdToken: { _ in })
        XCTAssertEqual(token, "token-1")
        XCTAssertEqual(provider.extractIdToken(from: token), "token-1")
        try await provider.logout()
    }

    /// Clerk tokens live about a minute, so fresh ones are pushed before the old one expires,
    /// and a sign-out elsewhere pushes nil so Convex drops the identity.
    func testPushesFreshTokensThenNilAfterSignOut() async throws {
        let clerk = FakeClerk()
        clerk.hasActiveSession = true
        let pushed = Pushed()
        let provider = ClerkConvexTokenProvider(refreshInterval: .milliseconds(20)) { clerk }
        _ = try await provider.loginFromCache(onIdToken: { pushed.append($0) })
        clerk.token = "token-2"
        let refreshed = await eventually { pushed.all.contains("token-2") }
        XCTAssertTrue(refreshed)
        clerk.hasActiveSession = false
        let cleared = await eventually { pushed.all.last == .some(nil) }
        XCTAssertTrue(cleared)
        try await provider.logout()
    }

    func testOfflineRefreshKeepsTheCurrentToken() async throws {
        let clerk = FakeClerk()
        clerk.hasActiveSession = true
        let pushed = Pushed()
        let provider = ClerkConvexTokenProvider(refreshInterval: .milliseconds(10)) { clerk }
        _ = try await provider.login(onIdToken: { pushed.append($0) })
        clerk.tokenError = URLError(.notConnectedToInternet)
        let start = clerk.tokenRequests
        let retried = await eventually { clerk.tokenRequests >= start + 3 }
        XCTAssertTrue(retried, "keeps trying while offline")
        XCTAssertFalse(pushed.all.contains(where: { $0 == nil }), "offline is not signed out")
        try await provider.logout()
    }
}
