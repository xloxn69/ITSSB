import XCTest
@testable import ITSSB

/// A scriptable `AuthSession`. Records calls; never touches the network.
@MainActor
private final class StubAuth: AuthSession {
    var isConfigured = true
    var accountLabel: String? { "sam.example@example.com" }
    var restoreResult: Result<Bool, AuthError> = .success(false)
    var sendError: AuthError?
    var verifyError: AuthError?
    var appleError: AuthError?
    private(set) var calls: [String] = []

    func restore() async throws -> Bool {
        calls.append("restore")
        return try restoreResult.get()
    }
    func sendEmailCode(to email: String) async throws {
        calls.append("send \(email)")
        if let sendError { throw sendError }
    }
    func resendEmailCode() async throws { calls.append("resend") }
    func verifyEmailCode(_ code: String) async throws {
        calls.append("verify \(code)")
        if let verifyError { throw verifyError }
    }
    func signInWithApple() async throws {
        calls.append("apple")
        if let appleError { throw appleError }
    }
    func signOut() async { calls.append("signOut") }
}

@MainActor
final class SessionStoreTests: XCTestCase {
    private var clock = Date(timeIntervalSince1970: 1_000)

    private func store(_ auth: StubAuth) -> SessionStore {
        SessionStore(auth: auth, now: { [unowned self] in clock })
    }

    func testStartsRestoring() {
        XCTAssertEqual(store(StubAuth()).state, .restoring)
    }

    func testNotConfiguredNeverCallsTheProvider() async {
        let auth = StubAuth()
        auth.isConfigured = false
        let session = store(auth)
        await session.restore()
        XCTAssertEqual(session.state, .signedOut(.signInUnavailable))
        XCTAssertEqual(auth.calls, [])
    }

    func testRestoresACachedSession() async {
        let auth = StubAuth()
        auth.restoreResult = .success(true)
        let session = store(auth)
        await session.restore()
        XCTAssertEqual(session.state, .signedIn)
    }

    func testOfflineRestoreIsRetryableNotSignedOut() async {
        let auth = StubAuth()
        auth.restoreResult = .failure(.network)
        let session = store(auth)
        await session.restore()
        XCTAssertEqual(session.state, .restoreFailed)
        auth.restoreResult = .success(true)
        await session.restore()
        XCTAssertEqual(session.state, .signedIn)
    }

    func testRestoreRejectedByTrackingSignsOutWithAReason() async {
        let auth = StubAuth()
        auth.restoreResult = .failure(.trackingRejected)
        let session = store(auth)
        await session.restore()
        XCTAssertEqual(session.state, .signedOut(.notSignedIn))
        XCTAssertEqual(session.message, AuthError.trackingRejected.message)
        XCTAssertTrue(auth.calls.contains("signOut"))
    }

    func testInvalidEmailIsCaughtLocally() async {
        let auth = StubAuth()
        let session = store(auth)
        await session.submitEmail("not-an-email")
        XCTAssertEqual(session.message, AuthError.invalidEmail.message)
        XCTAssertEqual(session.step, .email)
        XCTAssertEqual(auth.calls, [], "no request for an invalid address")
    }

    func testEmailCodeFlowSignsIn() async {
        let auth = StubAuth()
        let session = store(auth)
        await session.submitEmail("  sam.example@example.com ")
        XCTAssertEqual(session.step, .code(email: "sam.example@example.com"))
        await session.submitCode("123 456")
        XCTAssertEqual(session.state, .signedIn)
        XCTAssertEqual(auth.calls, ["send sam.example@example.com", "verify 123456"])
        XCTAssertEqual(session.step, .email, "the form resets for the next sign-in")
    }

    func testWrongCodeStaysOnTheCodeStepWithAMessage() async {
        let auth = StubAuth()
        auth.verifyError = .invalidCode
        let session = store(auth)
        await session.submitEmail("sam.example@example.com")
        await session.submitCode("000000")
        XCTAssertEqual(session.step, .code(email: "sam.example@example.com"))
        XCTAssertEqual(session.message, AuthError.invalidCode.message)
        XCTAssertNotEqual(session.state, .signedIn)
        XCTAssertFalse(session.isWorking)
    }

    func testNonNumericCodeIsRejectedLocally() async {
        let auth = StubAuth()
        let session = store(auth)
        await session.submitEmail("sam.example@example.com")
        await session.submitCode("12ab")
        XCTAssertEqual(session.message, AuthError.invalidCode.message)
        XCTAssertFalse(auth.calls.contains { $0.hasPrefix("verify") })
    }

    func testResendWaitsForTheCooldown() async {
        let auth = StubAuth()
        let session = store(auth)
        await session.submitEmail("sam.example@example.com")
        await session.resendCode()
        XCTAssertFalse(auth.calls.contains("resend"), "too soon")
        clock = clock.addingTimeInterval(SessionStore.resendCooldown)
        await session.resendCode()
        XCTAssertTrue(auth.calls.contains("resend"))
    }

    func testChangeEmailReturnsToTheEmailStep() async {
        let session = store(StubAuth())
        await session.submitEmail("sam.example@example.com")
        session.changeEmail()
        XCTAssertEqual(session.step, .email)
        XCTAssertNil(session.message)
    }

    func testTrackingRejectedReturnsToEmailWithAnHonestMessage() async {
        let auth = StubAuth()
        auth.verifyError = .trackingRejected
        let session = store(auth)
        await session.submitEmail("sam.example@example.com")
        await session.submitCode("123456")
        XCTAssertEqual(session.step, .email)
        XCTAssertEqual(session.message, AuthError.trackingRejected.message)
        XCTAssertNotEqual(session.state, .signedIn)
    }

    func testSignedInButTrackingUnreachableIsRetryable() async {
        let auth = StubAuth()
        auth.appleError = .trackingUnreachable
        let session = store(auth)
        await session.signInWithApple()
        XCTAssertEqual(session.state, .restoreFailed, "retry restores the kept provider session")
        XCTAssertFalse(auth.calls.contains("signOut"))
    }

    func testCancelledAppleSignInShowsNothing() async {
        let auth = StubAuth()
        auth.appleError = .cancelled
        let session = store(auth)
        await session.signInWithApple()
        XCTAssertNil(session.message)
        XCTAssertNotEqual(session.state, .signedIn)
    }

    func testAppleSignInSignsIn() async {
        let session = store(StubAuth())
        await session.signInWithApple()
        XCTAssertEqual(session.state, .signedIn)
    }

    func testSignOut() async {
        let auth = StubAuth()
        auth.restoreResult = .success(true)
        let session = store(auth)
        await session.restore()
        await session.signOut()
        XCTAssertEqual(session.state, .signedOut(.notSignedIn))
        XCTAssertTrue(auth.calls.contains("signOut"))
    }

    func testEmailPlausibility() {
        XCTAssertTrue(SessionStore.isPlausibleEmail("a.b@example.com"))
        for bad in ["", "a@b", "@example.com", "a b@example.com", "a@example"] {
            XCTAssertFalse(SessionStore.isPlausibleEmail(bad), bad)
        }
    }
}

final class AppConfigurationTests: XCTestCase {
    /// A key in Clerk's format: base64 of "<frontend api host>$". Fictional host.
    private let wellFormed = "pk_test_" + Data("example-name-00.clerk.accounts.dev$".utf8).base64EncodedString()

    func testAcceptsAWellFormedKey() {
        let config = AppConfiguration(convexURL: nil, clerkPublishableKey: wellFormed)
        XCTAssertEqual(config.clerkPublishableKey, wellFormed)
    }

    func testRejectsPlaceholdersAndEmpty() {
        for key in ["", "   ", "pk_test_EXAMPLE_NOT_A_REAL_KEY", "sk_test_abc", "pk_test_", "$(CLERK_PUBLISHABLE_KEY)",
                    "pk_test_" + Data("no-dollar.example".utf8).base64EncodedString()] {
            XCTAssertNil(AppConfiguration(convexURL: nil, clerkPublishableKey: key).clerkPublishableKey, key)
        }
    }

    func testNeverConfiguresClerkUnderTests() {
        let config = AppConfiguration.fromBundle(.main, environment: ["XCTestConfigurationFilePath": "/x"])
        XCTAssertNil(config.clerkPublishableKey)
    }

    func testDetectsThePlaceholderURL() {
        XCTAssertTrue(AppConfiguration(convexURL: URL(string: "http://127.0.0.1:1")).isPlaceholder)
        XCTAssertTrue(AppConfiguration(convexURL: nil).isPlaceholder)
        let real = AppConfiguration(convexURL: URL(string: "https://example-not-real-123.convex.cloud"))
        XCTAssertFalse(real.isPlaceholder)
    }
}
