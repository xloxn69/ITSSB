import XCTest
@testable import ITSSB

@MainActor
final class TrackViewModelTests: XCTestCase {
    private let alex = AssignmentSummary(assignmentId: "a_alex", relationship: .guardian,
                                         studentDisplayName: "Alex Example", routeLabel: "Route 17", stopLabel: "Oak")
    private let jordan = AssignmentSummary(assignmentId: "a_jordan", relationship: .guardian,
                                           studentDisplayName: "Jordan Example", routeLabel: "Route 4",
                                           stopLabel: "Elm")

    private func ready(_ assignmentId: String, busLabel: String = "Bus 12",
                       routeVersionId: String = "rv_1") -> RunSnapshot {
        let run = TrackedRun(runId: "run_\(assignmentId)", state: .active, liveRevision: 1, busLabel: busLabel,
                             lastDeviceContactAt: nil, gpsStatus: .valid,
                             position: PreviewFixtures.position(capturedSecondsAgo: 3),
                             assignedStop: PreviewFixtures.stop)
        return .ready(assignmentId: assignmentId, routeVersionId: routeVersionId, run: run, clock: .deviceOnly)
    }

    private func route(_ assignmentId: String, routeVersionId: String = "rv_1") -> RouteSnapshot {
        .ready(RouteGeometry(assignmentId: assignmentId, routeVersionId: routeVersionId, routeLabel: "Route 17",
                             path: PreviewFixtures.route.path, assignedStop: PreviewFixtures.stop))
    }

    private func started(_ source: MockLiveRunSource) async -> TrackViewModel {
        let model = TrackViewModel(source: source)
        model.start()
        _ = await eventually { source.assignmentsContinuation != nil }
        return model
    }

    func testStartsLoading() async {
        let model = await started(MockLiveRunSource())
        XCTAssertEqual(model.state, .loading)
    }

    func testReadyRunWithRouteBecomesTracking() async throws {
        let source = MockLiveRunSource()
        let model = await started(source)
        source.assignmentsContinuation?.yield(.ready([alex]))
        let reached = await eventually { source.runContinuation("a_alex") != nil }
        XCTAssertTrue(reached)
        XCTAssertEqual(model.state, .loading, "nothing shown until the run answers")

        source.routeContinuation("a_alex")?.yield(route("a_alex"))
        source.runContinuation("a_alex")?.yield(ready("a_alex"))
        let tracking = await eventually {
            if case let .tracking(context, run, _) = model.state {
                return context.route != nil && run.runId == "run_a_alex"
            }
            return false
        }
        XCTAssertTrue(tracking)
        XCTAssertEqual(model.selectedAssignmentId, "a_alex")
    }

    func testRouteForAnotherVersionIsNotDrawn() async {
        let source = MockLiveRunSource()
        let model = await started(source)
        source.assignmentsContinuation?.yield(.ready([alex]))
        _ = await eventually { source.runContinuation("a_alex") != nil }
        source.routeContinuation("a_alex")?.yield(route("a_alex", routeVersionId: "rv_old"))
        source.runContinuation("a_alex")?.yield(ready("a_alex", routeVersionId: "rv_new"))
        let reached = await eventually {
            if case let .tracking(context, _, _) = model.state { return context.route == nil }
            return false
        }
        XCTAssertTrue(reached)
    }

    func testNoActiveRun() async {
        let source = MockLiveRunSource()
        let model = await started(source)
        source.assignmentsContinuation?.yield(.ready([alex]))
        _ = await eventually { source.runContinuation("a_alex") != nil }
        source.runContinuation("a_alex")?.yield(.noActiveRun(assignmentId: "a_alex", routeVersionId: "rv_1"))
        let reached = await eventually {
            if case let .noActiveRun(context) = model.state { return context.assignment == self.alex }
            return false
        }
        XCTAssertTrue(reached)
    }

    func testNoApprovedAssignmentsIsAccessUnavailable() async {
        let source = MockLiveRunSource()
        let model = await started(source)
        source.assignmentsContinuation?.yield(.ready([]))
        let reached = await eventually { model.state == .accessUnavailable }
        XCTAssertTrue(reached)
        XCTAssertEqual(source.runSubscriptionCount, 0, "no tracking subscription without an assignment")
    }

    func testUnauthenticatedIsSessionExpired() async {
        let source = MockLiveRunSource()
        let model = await started(source)
        source.assignmentsContinuation?.yield(.accessUnavailable(.unauthenticated))
        let reached = await eventually { model.state == .sessionExpired }
        XCTAssertTrue(reached)
    }

    func testRevokedAccessClearsProtectedData() async {
        let source = MockLiveRunSource()
        let model = await started(source)
        source.assignmentsContinuation?.yield(.ready([alex]))
        _ = await eventually { source.runContinuation("a_alex") != nil }
        source.runContinuation("a_alex")?.yield(ready("a_alex"))
        _ = await eventually { if case .tracking = model.state { return true }; return false }

        source.runContinuation("a_alex")?.yield(.accessUnavailable(.notPermitted))
        let reached = await eventually { model.state == .accessUnavailable }
        XCTAssertTrue(reached)
        XCTAssertNil(model.selectedAssignmentId)
        let cancelled = await eventually { source.cancelledRuns.contains("a_alex") }
        XCTAssertTrue(cancelled, "the revoked subscription is cancelled")
    }

    func testTransportFailureIsAnErrorNotNoTrip() async {
        let source = MockLiveRunSource()
        let model = await started(source)
        source.assignmentsContinuation?.yield(.ready([alex]))
        _ = await eventually { source.runContinuation("a_alex") != nil }
        source.runContinuation("a_alex")?.finish(throwing: TrackingError.transport)
        let reached = await eventually { if case .failed = model.state { return true }; return false }
        XCTAssertTrue(reached)
    }

    func testInvalidDataIsAnError() async {
        let source = MockLiveRunSource()
        let model = await started(source)
        source.assignmentsContinuation?.finish(throwing: TrackingError.invalidData)
        let reached = await eventually { if case .failed = model.state { return true }; return false }
        XCTAssertTrue(reached)
    }

    func testSessionExpiredErrorFromRun() async {
        let source = MockLiveRunSource()
        let model = await started(source)
        source.assignmentsContinuation?.yield(.ready([alex]))
        _ = await eventually { source.runContinuation("a_alex") != nil }
        source.runContinuation("a_alex")?.finish(throwing: TrackingError.sessionExpired)
        let reached = await eventually { model.state == .sessionExpired }
        XCTAssertTrue(reached)
    }

    /// docs/06 §8: a late result for the previous student must never appear under the new one.
    func testLateResultForPreviousSelectionIsDropped() async {
        let source = MockLiveRunSource()
        let model = await started(source)
        source.assignmentsContinuation?.yield(.ready([alex, jordan]))
        _ = await eventually { source.runContinuation("a_alex") != nil }
        let alexRun = source.runContinuation("a_alex")

        model.select(assignmentId: "a_jordan")
        XCTAssertEqual(model.state, .loading, "old details are cleared immediately")
        _ = await eventually { source.runContinuation("a_jordan") != nil }

        alexRun?.yield(ready("a_alex", busLabel: "Alex's bus"))
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(model.state, .loading, "Alex's late result is ignored")

        source.runContinuation("a_jordan")?.yield(ready("a_jordan", busLabel: "Jordan's bus"))
        let reached = await eventually {
            if case let .tracking(context, run, _) = model.state {
                return context.assignment == self.jordan && run.busLabel == "Jordan's bus"
            }
            return false
        }
        XCTAssertTrue(reached)
        let cancelled = await eventually { source.cancelledRuns.contains("a_alex") }
        XCTAssertTrue(cancelled)
    }

    func testRetryResubscribes() async {
        let source = MockLiveRunSource()
        let model = await started(source)
        source.assignmentsContinuation?.finish(throwing: TrackingError.transport)
        _ = await eventually { if case .failed = model.state { return true }; return false }
        model.retry()
        XCTAssertEqual(model.state, .loading)
        let resubscribed = await eventually { source.assignmentSubscriptionCount == 2 }
        XCTAssertTrue(resubscribed)
        source.assignmentsContinuation?.yield(.ready([alex]))
        let reached = await eventually { source.runContinuation("a_alex") != nil }
        XCTAssertTrue(reached)
    }

    func testStopCancelsAndClears() async {
        let source = MockLiveRunSource()
        let model = await started(source)
        source.assignmentsContinuation?.yield(.ready([alex]))
        _ = await eventually { source.runContinuation("a_alex") != nil }
        model.stop()
        XCTAssertTrue(model.assignments.isEmpty)
        XCTAssertNil(model.selectedAssignmentId)
        let cancelled = await eventually { source.cancelledRuns.contains("a_alex") }
        XCTAssertTrue(cancelled)
    }
}
