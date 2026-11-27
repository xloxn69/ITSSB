@preconcurrency import ConvexMobile
import Foundation

/// Where alert data comes from (docs/08 §9.1). The app uses
/// `ConvexNotificationSource`; previews, screenshots, and tests use fakes.
protocol NotificationSource: Sendable {
    /// The caller's inbox; nil when access is unavailable.
    func alerts() -> AsyncThrowingStream<[AlertItem]?, Error>
    /// One assignment's preference; nil when access is unavailable.
    func preference(assignmentId: String) -> AsyncThrowingStream<NotificationPreference?, Error>
    /// Saves a choice and returns what the server stored.
    func savePreference(assignmentId: String, enabled: Bool, minutes: Int) async throws -> NotificationPreference
    /// Associates this installation's token and permission with the signed-in account.
    /// Returns whether the server can push to it now.
    func registerDevice(installationId: String, token: String?, environment: PushEnvironment,
                        permission: PushPermission) async throws -> Bool
}

/// Mutations with arguments. Separate from `ConvexQuerying` so its fakes stay small.
protocol ConvexCommanding: Sendable {
    func mutation<T: Decodable, Value: Sendable>(
        _ name: String, args: [String: ConvexEncodable?], as type: T.Type,
        transform: @escaping @Sendable (T) throws -> Value
    ) async throws -> Value
}

enum NotificationError: Error, Equatable {
    /// The server refused the request as malformed, or access is gone.
    case rejected
}

struct ConvexNotificationSource: NotificationSource {
    let queries: any ConvexQuerying
    let commands: any ConvexCommanding

    func alerts() -> AsyncThrowingStream<[AlertItem]?, Error> {
        queries.subscribe("notifications:myAlerts", args: [:], as: MyAlertsDTO.self) {
            try NotificationMapping.alerts(from: $0)
        }
    }

    func preference(assignmentId: String) -> AsyncThrowingStream<NotificationPreference?, Error> {
        queries.subscribe("notifications:myPreference", args: ["assignmentId": assignmentId],
                          as: MyPreferenceDTO.self) { try NotificationMapping.preference(from: $0) }
    }

    func savePreference(assignmentId: String, enabled: Bool, minutes: Int) async throws -> NotificationPreference {
        let args: [String: ConvexEncodable?] = [
            "requestId": UUID().uuidString.lowercased(),
            "assignmentId": assignmentId,
            "approachingEnabled": enabled,
            // Convex numbers are float64: send a Double, never an Int64.
            "approachingMinutes": Double(minutes)
        ]
        return try await commands.mutation("notifications:setPreferences", args: args,
                                           as: SetPreferencesDTO.self) { dto in
            guard case .saved(let saved) = dto else { throw NotificationError.rejected }
            try NotificationMapping.check(saved.schemaVersion)
            return try NotificationMapping.preference(from: saved.preference)
        }
    }

    func registerDevice(installationId: String, token: String?, environment: PushEnvironment,
                        permission: PushPermission) async throws -> Bool {
        let args: [String: ConvexEncodable?] = [
            "installationId": installationId,
            "apnsToken": token,
            "environment": environment.rawValue,
            "permission": permission.rawValue
        ]
        return try await commands.mutation("notifications:registerDevice", args: args,
                                           as: RegisterDeviceDTO.self) { dto in
            guard case .registered(let registered) = dto else { throw NotificationError.rejected }
            try NotificationMapping.check(registered.schemaVersion)
            return registered.pushEnabled
        }
    }
}
