import ConvexMobile
import Foundation

// Wire types for the family notification functions, contract version 1
// (docs/08 §9). Field names match `packages/contracts/src/notifications.ts`.

struct NotificationPreferenceDTO: Decodable {
    let assignmentId: String
    let approachingEnabled: Bool
    @ConvexFloat var approachingMinutes: Double
    @OptionalConvexFloat var updatedAtMs: Double?
}

// MARK: notifications:myPreference

enum MyPreferenceDTO: Decodable {
    case ready(Ready)
    case accessUnavailable(AccessUnavailableDTO)

    struct Ready: Decodable {
        @ConvexFloat var schemaVersion: Double
        @ConvexFloat var serverNowMs: Double
        let preference: NotificationPreferenceDTO
    }

    init(from decoder: Decoder) throws {
        switch try WireStatus.decode(from: decoder) {
        case "ready": self = .ready(try Ready(from: decoder))
        case "access_unavailable": self = .accessUnavailable(try AccessUnavailableDTO(from: decoder))
        case let other: throw WireStatus.unknown(other, decoder: decoder)
        }
    }
}

// MARK: notifications:setPreferences

enum SetPreferencesDTO: Decodable {
    case saved(Saved)
    case invalid(InvalidRequestDTO)
    case accessUnavailable(AccessUnavailableDTO)

    struct Saved: Decodable {
        @ConvexFloat var schemaVersion: Double
        @ConvexFloat var serverNowMs: Double
        let preference: NotificationPreferenceDTO
    }

    init(from decoder: Decoder) throws {
        switch try WireStatus.decode(from: decoder) {
        case "saved": self = .saved(try Saved(from: decoder))
        case "invalid": self = .invalid(try InvalidRequestDTO(from: decoder))
        case "access_unavailable": self = .accessUnavailable(try AccessUnavailableDTO(from: decoder))
        case let other: throw WireStatus.unknown(other, decoder: decoder)
        }
    }
}

/// `status: "invalid"`: the request was malformed; `message` is for logs, not the user.
struct InvalidRequestDTO: Decodable {
    @ConvexFloat var schemaVersion: Double
    @ConvexFloat var serverNowMs: Double
    let message: String
}

// MARK: notifications:registerDevice

enum RegisterDeviceDTO: Decodable {
    case registered(Registered)
    case invalid(InvalidRequestDTO)
    case accessUnavailable(AccessUnavailableDTO)

    struct Registered: Decodable {
        @ConvexFloat var schemaVersion: Double
        @ConvexFloat var serverNowMs: Double
        let pushEnabled: Bool
    }

    init(from decoder: Decoder) throws {
        switch try WireStatus.decode(from: decoder) {
        case "registered": self = .registered(try Registered(from: decoder))
        case "invalid": self = .invalid(try InvalidRequestDTO(from: decoder))
        case "access_unavailable": self = .accessUnavailable(try AccessUnavailableDTO(from: decoder))
        case let other: throw WireStatus.unknown(other, decoder: decoder)
        }
    }
}

// MARK: notifications:myAlerts

enum MyAlertsDTO: Decodable {
    case ready(Ready)
    case accessUnavailable(AccessUnavailableDTO)

    struct Ready: Decodable {
        @ConvexFloat var schemaVersion: Double
        @ConvexFloat var serverNowMs: Double
        let alerts: [AlertSummaryDTO]
    }

    init(from decoder: Decoder) throws {
        switch try WireStatus.decode(from: decoder) {
        case "ready": self = .ready(try Ready(from: decoder))
        case "access_unavailable": self = .accessUnavailable(try AccessUnavailableDTO(from: decoder))
        case let other: throw WireStatus.unknown(other, decoder: decoder)
        }
    }
}

struct AlertSummaryDTO: Decodable {
    let alertId: String
    let type: String
    let assignmentId: String
    let runId: String
    let stopLabel: String
    @ConvexFloat var createdAtMs: Double
    @ConvexFloat var predictedArrivalAtMs: Double
    @ConvexFloat var predictionGeneratedAtMs: Double
}
