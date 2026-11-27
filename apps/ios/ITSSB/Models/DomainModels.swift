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
/// A cached query result can carry an old `serverNowMs`, which makes the
/// server-aligned clock look *earlier*. `ageClock` therefore takes the later
/// of phone time and server-aligned time (docs/08 §8.1): clock error can make
/// a position look older, never fresher.
struct ServerClock: Equatable, Sendable {
    let serverNow: Date
    let receivedAt: Date

    /// Uses the phone clock alone, for fixtures and previews.
    static let deviceOnly = ServerClock(serverNow: .distantPast, receivedAt: .distantPast)

    func ageClock(at localNow: Date) -> Date {
        let aligned = localNow.addingTimeInterval(serverNow.timeIntervalSince(receivedAt))
        return max(localNow, aligned)
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
