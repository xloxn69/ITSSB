import Foundation

// Validated application types (docs/06 §7). Views only ever see these, never
// the wire DTOs. Wire times are UTC epoch milliseconds; `WireTime` converts
// them to `Date` explicitly, in one place.

/// Explicit epoch-millisecond conversion. Never pass wire milliseconds to `Date` directly.
enum WireTime {
    static func date(fromEpochMs ms: Double) -> Date {
        Date(timeIntervalSince1970: ms / 1000)
    }
}

/// Provisional freshness policy (docs/08 §8.1). Mirrors `POSITION_AGING_AFTER_MS`
/// and `POSITION_STALE_AFTER_MS` in `packages/contracts`; a test checks that
/// these match the shared `freshnessPolicy.json` fixture.
enum FreshnessPolicy {
    static let agingAfter: TimeInterval = 30
    static let staleAfter: TimeInterval = 120
}

/// How much to trust the shown position. Always derived from the clock at render
/// time, so a position becomes stale on its own without another update.
enum Freshness: Equatable, Sendable {
    case fresh
    case aging
    case stale

    init(age: TimeInterval) {
        switch age {
        case ..<FreshnessPolicy.agingAfter: self = .fresh
        case ..<FreshnessPolicy.staleAfter: self = .aging
        default: self = .stale
        }
    }
}

/// The server's clock reading at the moment a snapshot arrived on the phone.
///
/// A query's `serverNowMs` can come from a cached result, so it may be old,
/// and the phone clock may be wrong too (docs/08 §8.1). An **unverified**
/// clock therefore takes the later of phone time and query-aligned time, and
/// `LivePresentation` never calls a position fresh on it. A **verified** clock
/// comes from the uncached `tracking:serverTime` mutation and is used exactly.
struct ServerClock: Equatable, Sendable {
    let serverNow: Date
    let receivedAt: Date
    var isVerified = false

    /// Trusts the phone clock as is. For fixtures and previews only.
    static let deviceOnly = ServerClock(serverNow: .distantPast, receivedAt: .distantPast, isVerified: true)

    func ageClock(at localNow: Date) -> Date {
        let aligned = localNow.addingTimeInterval(serverNow.timeIntervalSince(receivedAt))
        return isVerified ? aligned : max(localNow, aligned)
    }
}

/// The bus's last accepted observation.
struct LivePosition: Equatable, Sendable {
    let eventId: String
    let latitude: Double
    let longitude: Double
    let speedMps: Double?
    let headingDegrees: Double?
    let horizontalAccuracyM: Double?
    /// When the Pi captured the fix. Age is always measured from this.
    let capturedAt: Date
    /// When the backend received it.
    let receivedAt: Date

    func age(at now: Date, clock: ServerClock = .deviceOnly) -> TimeInterval {
        max(0, clock.ageClock(at: now).timeIntervalSince(capturedAt))
    }

    func freshness(at now: Date, clock: ServerClock = .deviceOnly) -> Freshness {
        Freshness(age: age(at: now, clock: clock))
    }
}

struct Coordinate: Equatable, Sendable {
    let latitude: Double
    let longitude: Double
}

enum RunState: String, Equatable, Sendable {
    case scheduled, active, completed, cancelled

    /// Only an active run may show a bus marker as its current position.
    var showsLiveMarker: Bool { self == .active }
}

enum GpsStatus: String, Equatable, Sendable {
    case valid
    case noFix = "no_fix"
    case receiverMissing = "receiver_missing"
}

enum StopStatus: String, Equatable, Sendable {
    case upcoming
    case atStop = "at_stop"
    case passed
    case unknown
}

struct AssignedStop: Equatable, Sendable {
    let stopId: String
    let label: String
    let coordinate: Coordinate
    let status: StopStatus
}

struct TrackedRun: Equatable, Sendable {
    let runId: String
    let state: RunState
    let liveRevision: Int
    let busLabel: String
    let lastDeviceContactAt: Date?
    let gpsStatus: GpsStatus?
    /// Nil when the bus has not reported, or its report failed validation.
    /// Never replaced by an invented coordinate.
    let position: LivePosition?
    let assignedStop: AssignedStop
}

enum AccessUnavailableReason: String, Equatable, Sendable {
    case unauthenticated
    case notPermitted = "not_permitted"
}

/// One validated `tracking:myRun` result.
enum RunSnapshot: Equatable, Sendable {
    case ready(assignmentId: String, routeVersionId: String, run: TrackedRun, clock: ServerClock)
    case noActiveRun(assignmentId: String, routeVersionId: String)
    case accessUnavailable(AccessUnavailableReason)

    /// The same snapshot measured against another clock (a verified one, once it arrives).
    func with(clock: ServerClock) -> RunSnapshot {
        guard case let .ready(assignmentId, routeVersionId, run, _) = self else { return self }
        return .ready(assignmentId: assignmentId, routeVersionId: routeVersionId, run: run, clock: clock)
    }
}

/// One validated `tracking:myRoute` result: the school's approved path.
struct RouteGeometry: Equatable, Sendable {
    let assignmentId: String
    let routeVersionId: String
    let routeLabel: String
    let path: [Coordinate]
    let assignedStop: AssignedStop
}

enum RouteSnapshot: Equatable, Sendable {
    case ready(RouteGeometry)
    case accessUnavailable(AccessUnavailableReason)
}

struct AssignmentSummary: Equatable, Sendable, Identifiable {
    enum Relationship: String, Sendable { case `self`, guardian }

    let assignmentId: String
    let relationship: Relationship
    let studentDisplayName: String
    let routeLabel: String
    let stopLabel: String

    var id: String { assignmentId }
}

enum AssignmentsSnapshot: Equatable, Sendable {
    case ready([AssignmentSummary])
    case accessUnavailable(AccessUnavailableReason)
}
