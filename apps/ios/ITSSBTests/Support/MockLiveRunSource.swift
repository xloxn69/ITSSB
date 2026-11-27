import Foundation
@testable import ITSSB

/// A `LiveRunSource` whose subscriptions the test drives by hand. Never touches the network.
final class MockLiveRunSource: LiveRunSource, @unchecked Sendable {
    private let lock = NSLock()
    private var assignmentStreams: [AsyncThrowingStream<AssignmentsSnapshot, Error>.Continuation] = []
    private var runStreams: [(String, AsyncThrowingStream<RunSnapshot, Error>.Continuation)] = []
    private var routeStreams: [(String, AsyncThrowingStream<RouteSnapshot, Error>.Continuation)] = []
    private(set) var cancelledRuns: [String] = []
    private var connectionStreams: [AsyncStream<Bool>.Continuation] = []

    func connection() -> AsyncStream<Bool> {
        let (stream, continuation) = AsyncStream<Bool>.makeStream()
        lock.withLock { connectionStreams.append(continuation) }
        return stream
    }

    /// Reports the phone's link to the backend as the SDK would.
    func setConnected(_ connected: Bool) {
        lock.withLock { connectionStreams.last }?.yield(connected)
    }

    var connectionSubscriptionCount: Int { lock.withLock { connectionStreams.count } }

    func assignments() -> AsyncThrowingStream<AssignmentsSnapshot, Error> {
        let (stream, continuation) = AsyncThrowingStream<AssignmentsSnapshot, Error>.makeStream()
        lock.withLock { assignmentStreams.append(continuation) }
        return stream
    }

    func run(assignmentId: String) -> AsyncThrowingStream<RunSnapshot, Error> {
        let (stream, continuation) = AsyncThrowingStream<RunSnapshot, Error>.makeStream()
        continuation.onTermination = { [weak self] _ in
            self?.lock.withLock { self?.cancelledRuns.append(assignmentId) }
        }
        lock.withLock { runStreams.append((assignmentId, continuation)) }
        return stream
    }

    func route(assignmentId: String) -> AsyncThrowingStream<RouteSnapshot, Error> {
        let (stream, continuation) = AsyncThrowingStream<RouteSnapshot, Error>.makeStream()
        lock.withLock { routeStreams.append((assignmentId, continuation)) }
        return stream
    }

    var assignmentsContinuation: AsyncThrowingStream<AssignmentsSnapshot, Error>.Continuation? {
        lock.withLock { assignmentStreams.last }
    }

    func runContinuation(_ assignmentId: String) -> AsyncThrowingStream<RunSnapshot, Error>.Continuation? {
        lock.withLock { runStreams.last { $0.0 == assignmentId }?.1 }
    }

    func routeContinuation(_ assignmentId: String) -> AsyncThrowingStream<RouteSnapshot, Error>.Continuation? {
        lock.withLock { routeStreams.last { $0.0 == assignmentId }?.1 }
    }

    var assignmentSubscriptionCount: Int { lock.withLock { assignmentStreams.count } }

    var runSubscriptionCount: Int { lock.withLock { runStreams.count } }
}

/// Polls until `condition` holds, yielding to let tasks run. Fails after `timeout`.
@MainActor
func eventually(timeout: TimeInterval = 2, _ condition: @MainActor () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return condition()
}
