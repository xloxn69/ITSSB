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
    func testABackendThatSeesNoIdentityRejectsTheSignIn() async {
        // reason: unauthenticated, i.e. the token was installed but the backend saw no identity.
        let querying = AssignmentsQuerying(fixture: "myRoute.accessUnavailable")
        let outcome = await ConvexClientAuth.confirm(querying: querying, timeout: .seconds(2))
        XCTAssertEqual(outcome, .rejected)
    }

    func testARecognizedButUnlinkedIdentityIsAccepted() async {
        // reason: not_permitted, signed in but not linked yet: the session is real; access is per query.
        let outcome = await ConvexClientAuth.confirm(querying: AssignmentsQuerying(fixture: "myRun.accessUnavailable"),
                                                     timeout: .seconds(2))
        XCTAssertEqual(outcome, .accepted)
    }

    func testARecognizedIdentityIsAccepted() async {
        let outcome = await ConvexClientAuth.confirm(querying: AssignmentsQuerying(fixture: "myAssignments.ready"),
                                                     timeout: .seconds(2))
        XCTAssertEqual(outcome, .accepted)
    }

    func testNoAnswerIsUnreachableNotRejected() async {
        let outcome = await ConvexClientAuth.confirm(querying: AssignmentsQuerying(fixture: nil),
                                                     timeout: .milliseconds(50))
        XCTAssertEqual(outcome, .unreachable)
    }

    func testOfflineTokenFetchIsUnreachable() {
        XCTAssertEqual(ConvexClientAuth.outcome(forLoginError: AuthError.network), .unreachable)
        XCTAssertEqual(ConvexClientAuth.outcome(forLoginError: URLError(.notConnectedToInternet)), .unreachable)
        XCTAssertEqual(ConvexClientAuth.outcome(forLoginError: ClerkConvexTokenProvider.NoSession()), .rejected)
    }
}
