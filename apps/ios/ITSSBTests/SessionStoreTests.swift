import XCTest
@testable import ITSSB

private struct StubAuth: AuthSession {
    var isConfigured = true
    var restores = false
    var signInFails = false
    struct Failed: Error {}

    func restore() async -> Bool { restores }
    func signIn() async throws { if signInFails { throw Failed() } }
    func signOut() async {}
}

@MainActor
final class SessionStoreTests: XCTestCase {
    func testStartsRestoring() {
        XCTAssertEqual(SessionStore(auth: StubAuth()).state, .restoring)
    }

    func testUnconfiguredProviderSaysSignInIsUnavailable() async {
        let store = SessionStore(auth: StubAuth(isConfigured: false))
        await store.restore()
        XCTAssertEqual(store.state, .signedOut(.signInUnavailable))
        await store.signIn()
        XCTAssertEqual(store.state, .signedOut(.signInUnavailable), "never pretends to sign in")
    }

    func testRestoresCachedSession() async {
        let store = SessionStore(auth: StubAuth(restores: true))
        await store.restore()
        XCTAssertEqual(store.state, .signedIn)
        await store.signOut()
        XCTAssertEqual(store.state, .signedOut(.notSignedIn))
    }

    func testNoCachedSession() async {
        let store = SessionStore(auth: StubAuth(restores: false))
        await store.restore()
        XCTAssertEqual(store.state, .signedOut(.notSignedIn))
    }

    func testFailedSignInStaysSignedOutWithAMessage() async {
        let store = SessionStore(auth: StubAuth(signInFails: true))
        await store.signIn()
        XCTAssertEqual(store.state, .signedOut(.notSignedIn))
        XCTAssertNotNil(store.signInError)
    }

    func testUnconfiguredConvexProviderNeverAuthenticates() async {
        let provider = UnconfiguredAuthProvider()
        let login = try? await provider.login(onIdToken: { _ in })
        let cached = try? await provider.loginFromCache(onIdToken: { _ in })
        XCTAssertNil(login)
        XCTAssertNil(cached)
    }

    func testConfigurationDetectsThePlaceholderURL() {
        XCTAssertTrue(AppConfiguration(convexURL: URL(string: "http://127.0.0.1:1")).isPlaceholder)
        XCTAssertTrue(AppConfiguration(convexURL: nil).isPlaceholder)
        let real = AppConfiguration(convexURL: URL(string: "https://example-not-real-123.convex.cloud"))
        XCTAssertFalse(real.isPlaceholder)
    }
}
