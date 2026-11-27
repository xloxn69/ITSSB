import Foundation

/// Fictional, stable data for previews, simulator screenshots, and tests
/// (docs/06 §3). Same people and places as `packages/contracts` fixtures.
/// Not a real route, student, or bus.
enum PreviewFixtures {
    static let assignment = AssignmentSummary(
        assignmentId: "demo_assignment_001", relationship: .self,
        studentDisplayName: "Sam Example", routeLabel: "Route 17 Morning", stopLabel: "Oak & Pine")

    static let stop = AssignedStop(
        stopId: "demo_stop_003", label: "Oak & Pine",
        coordinate: Coordinate(latitude: 34.105971, longitude: -83.977736), status: .unknown)

    static let route = RouteGeometry(
        assignmentId: assignment.assignmentId,
        routeVersionId: "demo_route_version_003",
        routeLabel: "Route 17 Morning",
        path: DemoRoute.path,
        assignedStop: stop)

    static func position(capturedSecondsAgo: TimeInterval, now: Date = Date()) -> LivePosition {
        let captured = now.addingTimeInterval(-capturedSecondsAgo)
        return LivePosition(
            eventId: "5fe2a60d-7c11-45b9-995d-f50192adea42", latitude: 34.112587, longitude: -83.99113,
            speedMps: 7.2, headingDegrees: 130, horizontalAccuracyM: nil,
            capturedAt: captured, receivedAt: captured.addingTimeInterval(0.4))
    }

    /// `contactAt` is the bus's last contact (`.some(nil)`: never). By default
    /// its position's receipt, or a moment ago when a heartbeat reports GPS
    /// without a position.
    static func run(state: RunState = .active, position: LivePosition?, gpsStatus: GpsStatus? = .valid,
                    contactAt: Date?? = nil) -> TrackedRun {
        let fallback = position?.receivedAt ?? (gpsStatus == nil ? nil : Date().addingTimeInterval(-2))
        let contact = contactAt ?? fallback
        return TrackedRun(runId: "demo_run_001", state: state, liveRevision: 27, busLabel: "Bus 12",
                   lastDeviceContactAt: contact, gpsStatus: gpsStatus,
                   position: position, assignedStop: stop)
    }
}

/// Each screen state the app can show, for previews and `-ITSSBScenario` screenshots.
enum PreviewScenario: String, CaseIterable, Sendable {
    case loading
    case live
    case aging
    case stale
    case awaitingPosition
    case gpsUnavailable
    case noActiveRun
    case accessUnavailable
    case sessionExpired
    case failed
}

/// A `LiveRunSource` that replays one scenario. Times are relative to when the
/// stream starts, so the age keeps advancing on screen.
struct PreviewLiveRunSource: LiveRunSource {
    var scenario: PreviewScenario = .live

    func assignments() -> AsyncThrowingStream<AssignmentsSnapshot, Error> {
        let scenario = scenario
        return Self.stream { continuation in
            switch scenario {
            case .accessUnavailable: continuation.yield(.ready([]))
            case .sessionExpired: continuation.yield(.accessUnavailable(.unauthenticated))
            default: continuation.yield(.ready([PreviewFixtures.assignment]))
            }
        }
    }

    func run(assignmentId: String) -> AsyncThrowingStream<RunSnapshot, Error> {
        let scenario = scenario
        return Self.stream { continuation in
            let routeVersionId = PreviewFixtures.route.routeVersionId
            let ready = { (run: TrackedRun) in
                continuation.yield(.ready(assignmentId: assignmentId, routeVersionId: routeVersionId,
                                          run: run, clock: .deviceOnly))
            }
            switch scenario {
            case .loading, .accessUnavailable, .sessionExpired:
                break
            case .live: ready(PreviewFixtures.run(position: PreviewFixtures.position(capturedSecondsAgo: 4)))
            case .aging: ready(PreviewFixtures.run(position: PreviewFixtures.position(capturedSecondsAgo: 50)))
            case .stale: ready(PreviewFixtures.run(position: PreviewFixtures.position(capturedSecondsAgo: 300),
                                                   gpsStatus: nil))
            case .awaitingPosition: ready(PreviewFixtures.run(position: nil, gpsStatus: nil))
            case .gpsUnavailable: ready(PreviewFixtures.run(position: PreviewFixtures.position(capturedSecondsAgo: 20),
                                                            gpsStatus: .noFix))
            case .noActiveRun:
                continuation.yield(.noActiveRun(assignmentId: assignmentId, routeVersionId: routeVersionId))
            case .failed:
                continuation.finish(throwing: TrackingError.transport)
            }
        }
    }

    func route(assignmentId: String) -> AsyncThrowingStream<RouteSnapshot, Error> {
        let scenario = scenario
        return Self.stream { continuation in
            if scenario != .loading { continuation.yield(.ready(PreviewFixtures.route)) }
        }
    }

    /// A subscription that stays open after its initial values, like a live query.
    private static func stream<T>(
        _ body: (AsyncThrowingStream<T, Error>.Continuation) -> Void
    ) -> AsyncThrowingStream<T, Error> {
        let (stream, continuation) = AsyncThrowingStream<T, Error>.makeStream()
        body(continuation)
        return stream
    }
}
