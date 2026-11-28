import ConvexMobile
import Foundation

// Wire types for the family tracking queries, contract version 1 (docs/08 §8).
//
// Field names match docs/08 and `packages/contracts/src/tracking.ts` exactly.
// JavaScript numbers decode through Convex's float wrappers (docs/06 §7);
// nothing here is trusted until `DomainMapping` validates it.

/// `status: "access_unavailable"`: only a safe reason, no protected fields.
struct AccessUnavailableDTO: Decodable {
    @ConvexFloat var schemaVersion: Double
    @ConvexFloat var serverNowMs: Double
    let reason: String
}

// MARK: tracking:serverTime

/// Uncached server time from a mutation (docs/08 §8.1).
struct ServerTimeDTO: Decodable {
    @ConvexFloat var schemaVersion: Double
    @ConvexFloat var serverNowMs: Double
}

// MARK: tracking:myAssignments

enum MyAssignmentsDTO: Decodable {
    case ready(Ready)
    case accessUnavailable(AccessUnavailableDTO)

    struct Ready: Decodable {
        @ConvexFloat var schemaVersion: Double
        @ConvexFloat var serverNowMs: Double
        let assignments: [AssignmentSummaryDTO]
    }

    init(from decoder: Decoder) throws {
        switch try WireStatus.decode(from: decoder) {
        case "ready": self = .ready(try Ready(from: decoder))
        case "access_unavailable": self = .accessUnavailable(try AccessUnavailableDTO(from: decoder))
        case let other: throw WireStatus.unknown(other, decoder: decoder)
        }
    }
}

struct AssignmentSummaryDTO: Decodable {
    let assignmentId: String
    let relationship: String
    let studentDisplayName: String
    let routeLabel: String
    let stopLabel: String
}

// MARK: tracking:myRun

enum MyRunDTO: Decodable {
    case ready(Ready)
    case noActiveRun(NoActiveRun)
    case accessUnavailable(AccessUnavailableDTO)

    struct Ready: Decodable {
        @ConvexFloat var schemaVersion: Double
        @ConvexFloat var serverNowMs: Double
        let assignmentId: String
        let routeVersionId: String
        let run: RunDTO
        /// Added after the first release: nil when an older deployment omits it.
        let serviceNotice: ServiceNoticeDTO?
    }

    struct NoActiveRun: Decodable {
        @ConvexFloat var schemaVersion: Double
        @ConvexFloat var serverNowMs: Double
        let assignmentId: String
        let routeVersionId: String
        /// Added after the first release: nil when an older deployment omits them.
        let endedRun: EndedRunDTO?
        let serviceNotice: ServiceNoticeDTO?
    }

    init(from decoder: Decoder) throws {
        switch try WireStatus.decode(from: decoder) {
        case "ready": self = .ready(try Ready(from: decoder))
        case "no_active_run": self = .noActiveRun(try NoActiveRun(from: decoder))
        case "access_unavailable": self = .accessUnavailable(try AccessUnavailableDTO(from: decoder))
        case let other: throw WireStatus.unknown(other, decoder: decoder)
        }
    }
}

struct RunDTO: Decodable {
    let runId: String
    let state: String
    @ConvexFloat var liveRevision: Double
    let busLabel: String
    @OptionalConvexFloat var lastDeviceContactAtMs: Double?
    let gpsStatus: String?
    let lastPosition: PositionDTO?
    let nextStopId: String?
    let assignedStop: StopDTO
    let eta: EtaDTO?
}

/// Today's finished trip on the route (`no_active_run.endedRun`). It has no position.
struct EndedRunDTO: Decodable {
    let runId: String
    let state: String
    let serviceDate: String
    @OptionalConvexFloat var endedAtMs: Double?
    let replacement: String?
    @ConvexFloat var validUntilMs: Double
}

/// Today's service-calendar entry (`serviceNotice`), district-wide.
struct ServiceNoticeDTO: Decodable {
    let serviceDate: String
    let status: String
    @OptionalConvexFloat var lateStartMinutes: Double?
    let notice: String
    @ConvexFloat var validUntilMs: Double
}

/// `run.lastPosition`. Matches the illustrative fragment in docs/06 §7.
struct PositionDTO: Decodable {
    let eventId: String
    @ConvexFloat var capturedAtMs: Double
    @ConvexFloat var receivedAtMs: Double
    @ConvexFloat var latitude: Double
    @ConvexFloat var longitude: Double
    @OptionalConvexFloat var speedMps: Double?
    @OptionalConvexFloat var headingDegrees: Double?
    @OptionalConvexFloat var horizontalAccuracyM: Double?
}

struct StopDTO: Decodable {
    let stopId: String
    let label: String
    @ConvexFloat var latitude: Double
    @ConvexFloat var longitude: Double
    /// Present on `myRun.run.assignedStop`; absent on `myRoute.assignedStop`.
    let status: String?
}

/// The baseline arrival estimate (docs/08 §8); mapped by `DomainMapping.eta(from:)`.
struct EtaDTO: Decodable {
    @ConvexFloat var arrivalAtMs: Double
    @ConvexFloat var generatedAtMs: Double
    @ConvexFloat var validUntilMs: Double
    @OptionalConvexFloat var lowerArrivalAtMs: Double?
    @OptionalConvexFloat var upperArrivalAtMs: Double?
    let algorithmVersion: String
    let sourceEventId: String
}

// MARK: tracking:myRoute

enum MyRouteDTO: Decodable {
    case ready(Ready)
    case accessUnavailable(AccessUnavailableDTO)

    struct Ready: Decodable {
        @ConvexFloat var schemaVersion: Double
        @ConvexFloat var serverNowMs: Double
        let assignmentId: String
        let routeVersionId: String
        let routeLabel: String
        let path: [RoutePointDTO]
        let assignedStop: StopDTO
    }

    init(from decoder: Decoder) throws {
        switch try WireStatus.decode(from: decoder) {
        case "ready": self = .ready(try Ready(from: decoder))
        case "access_unavailable": self = .accessUnavailable(try AccessUnavailableDTO(from: decoder))
        case let other: throw WireStatus.unknown(other, decoder: decoder)
        }
    }
}

struct RoutePointDTO: Decodable {
    @ConvexFloat var latitude: Double
    @ConvexFloat var longitude: Double
}

// MARK: Envelope discriminator

/// Shared by every DTO file (tracking and notifications).
enum WireStatus {
    enum Key: String, CodingKey { case status }

    static func decode(from decoder: Decoder) throws -> String {
        try decoder.container(keyedBy: Key.self).decode(String.self, forKey: .status)
    }

    static func unknown(_ status: String, decoder: Decoder) -> DecodingError {
        .dataCorrupted(.init(codingPath: decoder.codingPath + [Key.status],
                             debugDescription: "Unknown status \"\(status)\""))
    }
}
