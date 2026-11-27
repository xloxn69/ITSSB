import XCTest
@testable import ITSSB

/// Serves one `tracking:myAssignments` answer (or none). Never reaches the network.
private struct AssignmentsQuerying: ConvexQuerying {
    let fixture: String?

    func subscribe<T: Decodable, Value: Sendable>(
        _ name: String, args: [String: String], as type: T.Type,
        transform: @escaping @Sendable (T) throws -> Value
    ) -> AsyncThrowingStream<Value, Error> {
        let (stream, continuation) = AsyncThrowingStream<Value, Error>.makeStream()
        if let fixture, let data = try? ContractFixture.data(fixture),
           let dto = try? JSONDecoder().decode(T.self, from: data), let value = try? transform(dto) {
            continuation.yield(value)
        }
        return stream // Left open, like a live subscription that never answers.
    }

    func mutation<T: Decodable, Value: Sendable>(
        _ name: String, as type: T.Type, transform: @escaping @Sendable (T) throws -> Value
    ) async throws -> Value {
        throw TrackingError.transport
    }
}

/// Review finding: ConvexMobile's login success only installs a token; the backend must confirm it.
final class ConvexClientAuthTests: XCTestCase {
    private func outcome(_ fixture: String?, forcedRefreshes: Int = 0,
                         timeout: Duration = .seconds(2)) async -> ConvexLoginOutcome {
        let querying = AssignmentsQuerying(fixture: fixture)
        let answer = await ConvexClientAuth.firstAnswer(querying: querying, timeout: timeout)
        return ConvexClientAuth.outcome(for: answer, forcedRefreshesSinceLogin: forcedRefreshes)
    }

    func testABackendThatSeesNoIdentityRejectsTheSignIn() async {
        // reason: unauthenticated, i.e. the token was installed but the backend saw no identity.
        let result = await outcome("myRoute.accessUnavailable")
        XCTAssertEqual(result, .rejected)
    }

    /// Re-check finding: ConvexMobile answers a rejected JWT with silence and a forced token
    /// refresh, not an `unauthenticated` answer. That must be rejected, not a retry-only outage.
    func testSilenceWithAForcedRefreshIsRejected() async {
        let result = await outcome(nil, forcedRefreshes: 1, timeout: .milliseconds(50))
        XCTAssertEqual(result, .rejected)
    }

    func testARecognizedButUnlinkedIdentityIsAccepted() async {
        // reason: not_permitted, signed in but not linked yet: the session is real; access is per query.
        let result = await outcome("myRun.accessUnavailable")
        XCTAssertEqual(result, .accepted)
    }

    func testARecognizedIdentityIsAccepted() async {
        let result = await outcome("myAssignments.ready")
        XCTAssertEqual(result, .accepted)
    }

    func testSilenceWithoutAForcedRefreshIsUnreachable() async {
        let result = await outcome(nil, timeout: .milliseconds(50))
        XCTAssertEqual(result, .unreachable)
    }

    func testOfflineTokenFetchIsUnreachable() {
        XCTAssertEqual(ConvexClientAuth.outcome(forLoginError: AuthError.network), .unreachable)
        XCTAssertEqual(ConvexClientAuth.outcome(forLoginError: URLError(.notConnectedToInternet)), .unreachable)
        XCTAssertEqual(ConvexClientAuth.outcome(forLoginError: ClerkConvexTokenProvider.NoSession()), .rejected)
    }
}
