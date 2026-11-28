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
                    contactAt: Date?? = nil, stopStatus: StopStatus = .unknown, eta: RunEta? = nil) -> TrackedRun {
        let fallback = position?.receivedAt ?? (gpsStatus == nil ? nil : Date().addingTimeInterval(-2))
        let contact = contactAt ?? fallback
        return TrackedRun(runId: "demo_run_001", state: state, liveRevision: 27, busLabel: "Bus 12",
                          lastDeviceContactAt: contact, gpsStatus: gpsStatus, position: position,
                          assignedStop: AssignedStop(stopId: stop.stopId, label: stop.label,
                                                     coordinate: stop.coordinate, status: stopStatus),
                          eta: eta)
    }

    /// An estimate six minutes out, made from `position`, valid for the contract's window.
    static func eta(for position: LivePosition, now: Date = Date()) -> RunEta {
        RunEta(arrivalAt: position.capturedAt.addingTimeInterval(6 * 60),
               generatedAt: now.addingTimeInterval(-2),
               validUntil: position.capturedAt.addingTimeInterval(FreshnessPolicy.etaValidFor),
               algorithmVersion: "baseline-v1", sourceEventId: position.eventId)
    }

    static func alert(now: Date = Date()) -> AlertItem {
        AlertItem(alertId: "demo_alert_001", assignmentId: assignment.assignmentId, runId: "demo_run_001",
                  stopLabel: "Oak & Pine", createdAt: now.addingTimeInterval(-70),
                  predictedArrivalAt: now.addingTimeInterval(4 * 60),
                  predictionGeneratedAt: now.addingTimeInterval(-70))
    }

    /// Fictional ended trips and calendar notices, valid until tomorrow so the screen keeps them.
    static func notices(_ scenario: PreviewScenario) -> TripNotices {
        let today = Date.now.formatted(.iso8601.year().month().day())
        let ended = { (state: EndedRun.State, pending: Bool) in
            EndedRun(runId: "demo_run_001", state: state, serviceDate: today,
                     endedAt: Date.now.addingTimeInterval(-25 * 60), replacementPending: pending,
                     validUntil: Date.now.addingTimeInterval(86_400))
        }
        let notice = { (kind: ServiceNotice.Kind, text: String) in
            ServiceNotice(serviceDate: today, kind: kind, notice: text, validUntil: Date.now.addingTimeInterval(86_400))
        }
        switch scenario {
        case .cancelled: return TripNotices(endedRun: ended(.cancelled, false), serviceNotice: nil)
        case .replacementPending: return TripNotices(endedRun: ended(.cancelled, true), serviceNotice: nil)
        case .completed: return TripNotices(endedRun: ended(.completed, false), serviceNotice: nil)
        case .noService:
            return TripNotices(endedRun: nil, serviceNotice: notice(
                .noService, "No buses today: the school is closed for a teacher workday."))
        case .lateStart:
            return TripNotices(endedRun: nil, serviceNotice: notice(
                .lateStart(minutes: 20), "Buses run 20 minutes late this morning because of fog."))
        default: return .none
        }
    }
}

/// Each screen state the app can show, for previews and `-ITSSBScenario` screenshots.
enum PreviewScenario: String, CaseIterable, Sendable {
    case loading
    case live
    case eta
    case atStop
    case passed
    case alerts
    case aging
    case stale
    case awaitingPosition
    case gpsUnavailable
    /// A recent position, but the phone has just lost its own connection (I25).
    case offline
    case noActiveRun
    /// Staff cancelled today's trip (I27); with a replacement bus sent but not started.
    case cancelled
    case replacementPending
    case completed
    /// Today's service-calendar notice, before any trip runs.
    case noService
    case lateStart
    case accessUnavailable
    case sessionExpired
    case failed
}

/// A `LiveRunSource` that replays one scenario. Times are relative to when the
/// stream starts, so the age keeps advancing on screen.
struct PreviewLiveRunSource: LiveRunSource {
    var scenario: PreviewScenario = .live

    func connection() -> AsyncStream<Bool> {
        let scenario = scenario
        return AsyncStream { continuation in
            continuation.yield(true)
            if scenario == .offline { continuation.yield(false) }
        }
    }

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
                                          run: run, clock: .deviceOnly, notices: .none))
            }
            switch scenario {
            case .loading, .accessUnavailable, .sessionExpired:
                break
            case .live, .offline: ready(PreviewFixtures.run(position: PreviewFixtures.position(capturedSecondsAgo: 4)))
            case .eta, .alerts:
                let position = PreviewFixtures.position(capturedSecondsAgo: 4)
                ready(PreviewFixtures.run(position: position, stopStatus: .upcoming,
                                          eta: PreviewFixtures.eta(for: position)))
            case .atStop, .passed:
                ready(PreviewFixtures.run(position: PreviewFixtures.position(capturedSecondsAgo: 4),
                                          stopStatus: scenario == .atStop ? .atStop : .passed))
            case .aging: ready(PreviewFixtures.run(position: PreviewFixtures.position(capturedSecondsAgo: 50)))
            case .stale: ready(PreviewFixtures.run(position: PreviewFixtures.position(capturedSecondsAgo: 300),
                                                   gpsStatus: nil))
            case .awaitingPosition: ready(PreviewFixtures.run(position: nil, gpsStatus: nil))
            case .gpsUnavailable: ready(PreviewFixtures.run(position: PreviewFixtures.position(capturedSecondsAgo: 20),
                                                            gpsStatus: .noFix))
            case .noActiveRun, .cancelled, .replacementPending, .completed, .noService, .lateStart:
                continuation.yield(.noActiveRun(assignmentId: assignmentId, routeVersionId: routeVersionId,
                                                clock: .deviceOnly, notices: PreviewFixtures.notices(scenario)))
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

/// A `NotificationSource` for previews and screenshots. Saves are echoed, never sent anywhere.
struct PreviewNotificationSource: NotificationSource {
    var scenario: PreviewScenario = .live

    func alerts() -> AsyncThrowingStream<[AlertItem]?, Error> {
        let items = scenario == .alerts || scenario == .eta ? [PreviewFixtures.alert()] : []
        return AsyncThrowingStream { continuation in continuation.yield(items) }
    }

    func preference(assignmentId: String) -> AsyncThrowingStream<NotificationPreference?, Error> {
        let enabled = scenario == .alerts || scenario == .eta
        return AsyncThrowingStream { continuation in
            continuation.yield(NotificationPreference(assignmentId: assignmentId, approachingEnabled: enabled,
                                                      approachingMinutes: 5, updatedAt: nil))
        }
    }

    func savePreference(assignmentId: String, enabled: Bool, minutes: Int) async throws -> NotificationPreference {
        NotificationPreference(assignmentId: assignmentId, approachingEnabled: enabled, approachingMinutes: minutes,
                               updatedAt: Date())
    }

    func registerDevice(installationId: String, token: String?, environment: PushEnvironment,
                        permission: PushPermission) async throws -> Bool { false }
}
