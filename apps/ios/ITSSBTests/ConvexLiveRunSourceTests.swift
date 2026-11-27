@preconcurrency import ConvexMobile
import XCTest
@testable import ITSSB

/// Serves contract fixtures (or errors) in place of the Convex client. No network.
private struct FixtureQuerying: ConvexQuerying {
    var fixtures: [String: String] = [:]
    var error: Error?
    private(set) var calls = CallLog()

    final class CallLog: @unchecked Sendable {
        private let lock = NSLock()
        private var entries: [(String, [String: String])] = []
        func append(_ entry: (String, [String: String])) { lock.withLock { entries.append(entry) } }
        var all: [(String, [String: String])] { lock.withLock { entries } }
    }

    func subscribe<T: Decodable, Value: Sendable>(
        _ name: String, args: [String: String], as type: T.Type,
        transform: @escaping @Sendable (T) throws -> Value
    ) -> AsyncThrowingStream<Value, Error> {
        calls.append((name, args))
        let (stream, continuation) = AsyncThrowingStream<Value, Error>.makeStream()
        if let error {
            continuation.finish(throwing: error)
        } else if let fixture = fixtures[name] {
            do {
                let dto = try JSONDecoder().decode(T.self, from: ContractFixture.data(fixture))
                continuation.yield(try transform(dto))
                continuation.finish()
            } catch {
                continuation.finish(throwing: error)
            }
        }
        return stream
    }
}

final class ConvexLiveRunSourceTests: XCTestCase {
    private func first<T>(_ stream: AsyncThrowingStream<T, Error>) async throws -> T? {
        for try await value in stream { return value }
        return nil
    }

    func testCallsTheContractQueriesWithOnlyTheAssignmentId() async throws {
        let client = FixtureQuerying(fixtures: ["tracking:myRun": "myRun.ready"])
        let source = ConvexLiveRunSource(client: client)
        _ = try await first(source.run(assignmentId: "demo_assignment_001"))
        XCTAssertEqual(client.calls.all.first?.0, "tracking:myRun")
        XCTAssertEqual(client.calls.all.first?.1, ["assignmentId": "demo_assignment_001"])
    }

    func testMapsFixturesToDomainSnapshots() async throws {
        let received = Date(timeIntervalSince1970: 1_795_609_086)
        let source = ConvexLiveRunSource(
            client: FixtureQuerying(fixtures: ["tracking:myRun": "myRun.ready",
                                               "tracking:myRoute": "myRoute.ready",
                                               "tracking:myAssignments": "myAssignments.ready"]),
            now: { received })
        guard case let .ready(_, _, run, clock)? = try await first(source.run(assignmentId: "x")) else {
            return XCTFail("expected ready")
        }
        XCTAssertEqual(run.liveRevision, 27)
        XCTAssertEqual(clock.receivedAt, received)
        guard case let .ready(route)? = try await first(source.route(assignmentId: "x")) else {
            return XCTFail("expected route")
        }
        XCTAssertEqual(route.path.count, 5)
        guard case let .ready(list)? = try await first(source.assignments()) else { return XCTFail("expected list") }
        XCTAssertEqual(list.count, 1)
    }

    func testErrorMapping() {
        XCTAssertEqual(ConvexLiveRunSource.trackingError(ClientError.ConvexError(data: #"{"code":"UNAUTHENTICATED"}"#)),
                       .sessionExpired)
        XCTAssertEqual(ConvexLiveRunSource.trackingError(ClientError.ServerError(msg: "boom")), .transport)
        XCTAssertEqual(ConvexLiveRunSource.trackingError(ClientError.InternalError(msg: "socket")), .transport)
        XCTAssertEqual(ConvexLiveRunSource.trackingError(MappingError.invalidField("x")), .invalidData)
    }

    func testInvalidPayloadSurfacesAsInvalidData() async {
        let source = ConvexLiveRunSource(client: FixtureQuerying(error: MappingError.unsupportedSchemaVersion(2)))
        do {
            _ = try await first(source.run(assignmentId: "x"))
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? TrackingError, .invalidData)
        }
    }
}
