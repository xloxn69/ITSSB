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
    /// Mirrors `ETA_VALID_FOR_MS`: an estimate is valid until its position's capture time plus this.
    static let etaValidFor: TimeInterval = 60
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
/// and the phone clock may be wrong too (docs/08 §8.1).
/// - **Unverified** (from a query): takes the later of phone time and
///   query-aligned time, and `freshness` never reports `.fresh` on it.
/// - **Verified** (from the uncached `tracking:serverTime` mutation): advances
///   from the server's reading by monotonic elapsed time, which keeps counting
///   through sleep and ignores phone clock changes, plus the round-trip
///   uncertainty, so any error can only make a position look older.
struct ServerClock: Equatable, Sendable {
    let serverNow: Date
    let receivedAt: Date
    var isVerified = false
    /// Verified only: the monotonic instant that corresponds to `serverNow`.
    var monotonicAt: ContinuousClock.Instant?
    /// Verified only: half the round trip, added so the error never favors freshness.
    var uncertainty: TimeInterval = 0

    /// Trusts the phone clock as is. For fixtures and previews only.
    static let deviceOnly = ServerClock(serverNow: .distantPast, receivedAt: .distantPast, isVerified: true)

    func ageClock(at localNow: Date, monotonicNow: ContinuousClock.Instant = .now) -> Date {
        if isVerified, let monotonicAt {
            return serverNow.addingTimeInterval(monotonicAt.duration(to: monotonicNow).seconds + uncertainty)
        }
        if isVerified { return localNow }
        let aligned = localNow.addingTimeInterval(serverNow.timeIntervalSince(receivedAt))
        return max(localNow, aligned)
    }
}

extension Duration {
    var seconds: TimeInterval {
        Double(components.seconds) + Double(components.attoseconds) / 1e18
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

    func age(at now: Date, clock: ServerClock = .deviceOnly,
             monotonicNow: ContinuousClock.Instant = .now) -> TimeInterval {
        max(0, clock.ageClock(at: now, monotonicNow: monotonicNow).timeIntervalSince(capturedAt))
    }

    /// The one place freshness is decided. Without verified server time a cached
    /// snapshot and a slow phone clock can both understate age, so it is never `.fresh`.
    func freshness(at now: Date, clock: ServerClock = .deviceOnly,
                   monotonicNow: ContinuousClock.Instant = .now) -> Freshness {
        let freshness = Freshness(age: age(at: now, clock: clock, monotonicNow: monotonicNow))
        return !clock.isVerified && freshness == .fresh ? .aging : freshness
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

/// A server arrival estimate (docs/08 §8). Shown only through `EtaPresentation`, which ages it.
struct RunEta: Equatable, Sendable {
    let arrivalAt: Date
    let generatedAt: Date
    let validUntil: Date
    let algorithmVersion: String
    /// The position it was computed from; must be the one on screen.
    let sourceEventId: String
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
    /// Nil when absent or malformed; never repaired or guessed.
    var eta: RunEta?
}

enum AccessUnavailableReason: String, Equatable, Sendable {
    case unauthenticated
    case notPermitted = "not_permitted"
}

/// Today's finished trip on the assignment's route (docs/08 §8). Never has a
/// position: a finished trip's last point is not shown as current.
struct EndedRun: Equatable, Sendable {
    enum State: String, Equatable, Sendable { case completed, cancelled }

    let runId: String
    let state: State
    let serviceDate: String
    let endedAt: Date?
    /// Staff sent a replacement bus that hasn't started yet.
    let replacementPending: Bool
    /// End of its service day; hidden from then on.
    let validUntil: Date
}

/// Today's service-calendar entry (docs/12 §3). District-wide.
struct ServiceNotice: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case noService
        case lateStart(minutes: Int)
    }

    let serviceDate: String
    let kind: Kind
    /// The family-facing text staff wrote.
    let notice: String
    let validUntil: Date
}

/// What `tracking:myRun` says about today beyond the live run.
struct TripNotices: Equatable, Sendable {
    var endedRun: EndedRun?
    var serviceNotice: ServiceNotice?

    static let none = TripNotices(endedRun: nil, serviceNotice: nil)

    /// Only what still describes today. The backend query isn't re-run when a
    /// day ends, so yesterday's status would otherwise stay on screen.
    func current(at serverNow: Date) -> TripNotices {
        TripNotices(endedRun: endedRun.flatMap { serverNow < $0.validUntil ? $0 : nil },
                    serviceNotice: serviceNotice.flatMap { serverNow < $0.validUntil ? $0 : nil })
    }
}

/// One validated `tracking:myRun` result.
enum RunSnapshot: Equatable, Sendable {
    case ready(assignmentId: String, routeVersionId: String, run: TrackedRun, clock: ServerClock,
               notices: TripNotices)
    case noActiveRun(assignmentId: String, routeVersionId: String, clock: ServerClock, notices: TripNotices)
    case accessUnavailable(AccessUnavailableReason)

    /// The same snapshot measured against another clock (a verified one, once it arrives).
    func with(clock: ServerClock) -> RunSnapshot {
        switch self {
        case let .ready(assignmentId, routeVersionId, run, _, notices):
            .ready(assignmentId: assignmentId, routeVersionId: routeVersionId, run: run, clock: clock,
                   notices: notices)
        case let .noActiveRun(assignmentId, routeVersionId, _, notices):
            .noActiveRun(assignmentId: assignmentId, routeVersionId: routeVersionId, clock: clock, notices: notices)
        case .accessUnavailable:
            self
        }
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
