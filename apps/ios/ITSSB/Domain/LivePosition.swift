import Foundation

/// The bus's last observed position, as a domain value.
///
/// Built from the backend's wire DTO (docs/08 §8). Wire times are UTC epoch
/// milliseconds; they are converted to `Date` here, explicitly, once.
struct LivePosition: Equatable, Sendable {
    let latitude: Double
    let longitude: Double
    let speedMps: Double?
    let headingDegrees: Double?
    /// When the Pi captured the fix. Age is always measured from this.
    let capturedAt: Date
    /// When the backend received it.
    let receivedAt: Date

    init(latitude: Double, longitude: Double, speedMps: Double?, headingDegrees: Double?,
         capturedAt: Date, receivedAt: Date) {
        self.latitude = latitude
        self.longitude = longitude
        self.speedMps = speedMps
        self.headingDegrees = headingDegrees
        self.capturedAt = capturedAt
        self.receivedAt = receivedAt
    }

    /// Validates and converts a wire DTO. Returns nil for values that are not a real location.
    init?(wire: LivePositionDTO) {
        guard wire.latitude.isFinite, wire.longitude.isFinite,
              (-90...90).contains(wire.latitude), (-180...180).contains(wire.longitude),
              wire.capturedAtMs.isFinite, wire.receivedAtMs.isFinite else { return nil }
        self.init(
            latitude: wire.latitude,
            longitude: wire.longitude,
            speedMps: wire.speedMps,
            headingDegrees: wire.headingDegrees,
            capturedAt: Date(timeIntervalSince1970: wire.capturedAtMs / 1000),
            receivedAt: Date(timeIntervalSince1970: wire.receivedAtMs / 1000)
        )
    }

    func age(at now: Date) -> TimeInterval {
        max(0, now.timeIntervalSince(capturedAt))
    }

    func freshness(at now: Date) -> Freshness {
        Freshness(age: age(at: now))
    }
}

/// Wire shape of `runs.live().position`. Field names match docs/08 exactly.
struct LivePositionDTO: Decodable, Sendable {
    let latitude: Double
    let longitude: Double
    let speedMps: Double?
    let headingDegrees: Double?
    let capturedAtMs: Double
    let receivedAtMs: Double
}

/// How much to trust the shown position.
///
/// Thresholds are provisional (docs/17 §5, "Freshness and alert thresholds")
/// and must be tuned from measured runs before a pilot.
enum Freshness: Equatable, Sendable {
    case fresh
    case aging
    case stale

    static let agingAfter: TimeInterval = 30
    static let staleAfter: TimeInterval = 120

    init(age: TimeInterval) {
        switch age {
        case ..<Self.agingAfter: self = .fresh
        case ..<Self.staleAfter: self = .aging
        default: self = .stale
        }
    }
}
