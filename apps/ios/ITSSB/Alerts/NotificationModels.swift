import Foundation

/// One in-app inbox entry (docs/08 §9.1). It describes a past estimate, never the current one.
struct AlertItem: Equatable, Sendable, Identifiable {
    let alertId: String
    let assignmentId: String
    let runId: String
    let stopLabel: String
    let createdAt: Date
    let predictedArrivalAt: Date
    let predictionGeneratedAt: Date

    var id: String { alertId }
}

/// A person's approaching-alert choice for one assignment. Separate from the OS permission.
struct NotificationPreference: Equatable, Sendable {
    let assignmentId: String
    let approachingEnabled: Bool
    let approachingMinutes: Int
    /// Nil while these are the defaults.
    let updatedAt: Date?
}

/// The operating system's notification permission, as sent to `notifications:registerDevice`.
enum PushPermission: String, Equatable, Sendable {
    case authorized, provisional, denied
    case notDetermined = "not_determined"

    var allowsAlerts: Bool { self == .authorized || self == .provisional }
}

enum PushEnvironment: String, Sendable {
    case sandbox, production
}

enum NotificationMapping {
    static let approachingMinutesRange = 1...30

    static func alerts(from dto: MyAlertsDTO) throws -> [AlertItem]? {
        switch dto {
        case .ready(let ready):
            try check(ready.schemaVersion)
            return try ready.alerts.map { item in
                guard item.type == "approaching" else { throw MappingError.invalidField("alerts.type") }
                return AlertItem(
                    alertId: item.alertId, assignmentId: item.assignmentId, runId: item.runId,
                    stopLabel: item.stopLabel,
                    createdAt: try DomainMapping.timestamp(item.createdAtMs, field: "alerts.createdAtMs"),
                    predictedArrivalAt: try DomainMapping.timestamp(item.predictedArrivalAtMs,
                                                                    field: "alerts.predictedArrivalAtMs"),
                    predictionGeneratedAt: try DomainMapping.timestamp(item.predictionGeneratedAtMs,
                                                                       field: "alerts.predictionGeneratedAtMs"))
            }
        case .accessUnavailable:
            return nil
        }
    }

    static func preference(from dto: NotificationPreferenceDTO) throws -> NotificationPreference {
        let minutes = try DomainMapping.safeWholeNumber(dto.approachingMinutes, field: "preference.approachingMinutes")
        guard approachingMinutesRange.contains(minutes) else {
            throw MappingError.invalidField("preference.approachingMinutes")
        }
        return NotificationPreference(
            assignmentId: dto.assignmentId, approachingEnabled: dto.approachingEnabled, approachingMinutes: minutes,
            updatedAt: try dto.updatedAtMs.map { try DomainMapping.timestamp($0, field: "preference.updatedAtMs") })
    }

    static func preference(from dto: MyPreferenceDTO) throws -> NotificationPreference? {
        switch dto {
        case .ready(let ready):
            try check(ready.schemaVersion)
            return try preference(from: ready.preference)
        case .accessUnavailable:
            return nil
        }
    }

    static func check(_ version: Double) throws {
        guard version == DomainMapping.schemaVersion else { throw MappingError.unsupportedSchemaVersion(version) }
    }

    /// APNs device tokens are sent as lowercase hex.
    static func hex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }
}
