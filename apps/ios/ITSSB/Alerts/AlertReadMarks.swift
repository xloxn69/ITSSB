import Foundation
import Observation

/// Which inbox alerts this phone has opened (docs/06 I20 unread state). Local
/// only: alert IDs are opaque, and only the most recent ones are kept.
@MainActor @Observable
final class AlertReadMarks {
    static let limit = 200
    private static let key = "alerts.readIds"

    private(set) var readIds: [String]
    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        readIds = defaults.stringArray(forKey: Self.key) ?? []
    }

    func isRead(_ alertId: String) -> Bool { readIds.contains(alertId) }

    func markRead(_ alertId: String) {
        guard !isRead(alertId) else { return }
        readIds = Array((readIds + [alertId]).suffix(Self.limit))
        defaults.set(readIds, forKey: Self.key)
    }

    /// Sign-out: the next account starts with nothing marked.
    func clear() {
        readIds = []
        defaults.removeObject(forKey: Self.key)
    }
}
