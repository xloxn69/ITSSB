@preconcurrency import ConvexMobile
import XCTest
@testable import ITSSB

/// Serves contract fixtures (or errors) in place of the Convex client. No network.
private struct FixtureQuerying: ConvexQuerying {
    var fixtures: [String: String] = [:]
    var error: Error?
    /// Fixture for `tracking:serverTime`, or nil to make the mutation fail (offline).
    var serverTimeFixture: String? = "serverTime"
    /// Keep the subscription open after its value, like a live query.
    var keepOpen = false
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
                if !keepOpen { continuation.finish() }
            } catch {
                continuation.finish(throwing: error)
            }
        }
        return stream
    }
}

extension FixtureQuerying {
    func mutation<T: Decodable, Value: Sendable>(
        _ name: String, as type: T.Type, transform: @escaping @Sendable (T) throws -> Value
    ) async throws -> Value {
        calls.append((name, [:]))
        guard name == "tracking:serverTime", let serverTimeFixture else { throw TrackingError.transport }
        return try transform(JSONDecoder().decode(T.self, from: ContractFixture.data(serverTimeFixture)))
    }
}

/// Holds `tracking:serverTime` open until `release()`, like a slow, uncancellable SDK call.
private final class MutationGate: @unchecked Sendable {
    private let lock = NSLock()
    private var continuations: [CheckedContinuation<Void, Never>] = []
    private var open = false

    func wait() async {
        await withCheckedContinuation { continuation in
            let resumeNow = lock.withLock { () -> Bool in
                if open { return true }
                continuations.append(continuation)
                return false
            }
            if resumeNow { continuation.resume() }
        }
    }

    func release() {
        let pending = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
            open = true
            defer { continuations = [] }
            return continuations
        }
        pending.forEach { $0.resume() }
    }
}

private struct BlockingTimeQuerying: ConvexQuerying {
    let gate: MutationGate
    private let inner = FixtureQuerying(fixtures: ["tracking:myRun": "myRun.ready"], keepOpen: true)

    init(gate: MutationGate) { self.gate = gate }

    func subscribe<T: Decodable, Value: Sendable>(
        _ name: String, args: [String: String], as type: T.Type,
        transform: @escaping @Sendable (T) throws -> Value
    ) -> AsyncThrowingStream<Value, Error> {
        inner.subscribe(name, args: args, as: type, transform: transform)
    }

    func mutation<T: Decodable, Value: Sendable>(
        _ name: String, as type: T.Type, transform: @escaping @Sendable (T) throws -> Value
    ) async throws -> Value {
        await gate.wait() // Ignores cancellation, as ConvexMobile 0.8.2 does.
        return try await inner.mutation(name, as: type, transform: transform)
    }
}

/// Fails `tracking:serverTime` once, then succeeds.
private final class FlakyTimeQuerying: ConvexQuerying, @unchecked Sendable {
    private let lock = NSLock()
    private var attempts = 0
    private let inner = FixtureQuerying(fixtures: ["tracking:myRun": "myRun.ready"], keepOpen: true)

    func subscribe<T: Decodable, Value: Sendable>(
        _ name: String, args: [String: String], as type: T.Type,
        transform: @escaping @Sendable (T) throws -> Value
    ) -> AsyncThrowingStream<Value, Error> {
        inner.subscribe(name, args: args, as: type, transform: transform)
    }

    func mutation<T: Decodable, Value: Sendable>(
        _ name: String, as type: T.Type, transform: @escaping @Sendable (T) throws -> Value
    ) async throws -> Value {
        let attempt = lock.withLock { () -> Int in
            attempts += 1
            return attempts
        }
        if attempt == 1 { throw TrackingError.transport }
        return try await inner.mutation(name, as: type, transform: transform)
    }
}

private func eventuallyAsync(timeout: TimeInterval = 2, _ condition: () async -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return await condition()
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
        XCTAssertEqual(route.path.count, 373)
        guard case let .ready(list)? = try await first(source.assignments()) else { return XCTFail("expected list") }
        XCTAssertEqual(list.count, 1)
    }

    private func clocks(_ client: FixtureQuerying) async throws -> [ServerClock] {
        var result: [ServerClock] = []
        for try await snapshot in ConvexLiveRunSource(client: client).run(assignmentId: "x") {
            if case let .ready(_, _, _, clock) = snapshot { result.append(clock) }
        }
        return result
    }

    func testRunIsRemeasuredOnceVerifiedTimeArrives() async throws {
        let client = FixtureQuerying(fixtures: ["tracking:myRun": "myRun.ready"], keepOpen: true)
        var iterator = ConvexLiveRunSource(client: client).run(assignmentId: "x").makeAsyncIterator()
        var seen: [ServerClock] = []
        while seen.last?.isVerified != true, seen.count < 2,
              case let .ready(_, _, _, clock)? = try await iterator.next() {
            seen.append(clock)
        }
        XCTAssertEqual(seen.last?.isVerified, true, "the latest snapshot carries verified time: \(seen)")
    }

    func testWithoutServerTimeNothingIsVerified() async throws {
        let clocks = try await clocks(FixtureQuerying(fixtures: ["tracking:myRun": "myRun.ready"],
                                                      serverTimeFixture: nil))
        XCTAssertEqual(clocks.count, 1)
        XCTAssertFalse(clocks[0].isVerified)
    }

    /// Review regression: ConvexMobile mutations can't be cancelled. One request is shared,
    /// and a cancelled subscription detaches instead of being retained by the pending call.
    func testOneSharedTimeRequestAndCancelledSubscribersDetach() async throws {
        let gate = MutationGate()
        let source = ConvexLiveRunSource(client: BlockingTimeQuerying(gate: gate))
        let first = Task { for try await _ in source.run(assignmentId: "a") {} }
        let second = source.run(assignmentId: "b")
        var iterator = second.makeAsyncIterator()
        let unverified = try await iterator.next()
        guard case let .ready(_, _, _, clock)? = unverified else { return XCTFail("expected ready") }
        XCTAssertFalse(clock.isVerified)

        first.cancel()
        let detached = await eventuallyAsync { await source.serverTime.waiterCount == 1 }
        XCTAssertTrue(detached, "the cancelled subscription is no longer retained")
        let requests = await source.serverTime.requestCount
        XCTAssertEqual(requests, 1, "two subscriptions share one pending request")

        gate.release()
        guard case let .ready(_, _, _, verified)? = try await iterator.next() else { return XCTFail("expected ready") }
        XCTAssertTrue(verified.isVerified)
        let waiters = await source.serverTime.waiterCount
        XCTAssertEqual(waiters, 0)
    }

    /// Re-check regression: a stream cancelled before its registration ran must not leave
    /// an orphan waiter that keeps the retry loop alive.
    func testUnregisterBeforeRegisterLeavesNoOrphan() async {
        let service = ServerTimeService(client: FlakyTimeQuerying(), now: { Date() })
        let id = UUID()
        await service.unregister(id)
        let clock = await service.register(id) { _ in }
        XCTAssertNil(clock)
        let waiters = await service.waiterCount
        let requests = await service.requestCount
        XCTAssertEqual(waiters, 0)
        XCTAssertEqual(requests, 0, "no request is started for a stream that already ended")
    }

    func testFailedTimeRequestIsRetried() async throws {
        let client = FlakyTimeQuerying()
        let source = ConvexLiveRunSource(client: client)
        await source.serverTime.setRetryDelay(.milliseconds(10))
        var iterator = source.run(assignmentId: "x").makeAsyncIterator()
        var seen: [ServerClock] = []
        while seen.last?.isVerified != true, seen.count < 2,
              case let .ready(_, _, _, clock)? = try await iterator.next() {
            seen.append(clock)
        }
        XCTAssertEqual(seen.last?.isVerified, true)
        let requests = await source.serverTime.requestCount
        XCTAssertEqual(requests, 2, "one failure, then a successful retry")
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
