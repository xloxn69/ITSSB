import Foundation
import Observation

/// The Alerts tab: each approved assignment's approaching-alert preference and
/// the in-app inbox, which stays useful when push is unavailable.
@MainActor @Observable
final class AlertsViewModel {
    enum State: Equatable { case loading, ready, unavailable, failed }

    private(set) var state: State = .loading
    private(set) var assignments: [AssignmentSummary] = []
    private(set) var alerts: [AlertItem] = []
    private(set) var preferences: [String: NotificationPreference] = [:]
    private(set) var saving: Set<String> = []
    private(set) var saveFailed: Set<String> = []

    @ObservationIgnored private let tracking: any LiveRunSource
    @ObservationIgnored private let notifications: any NotificationSource
    @ObservationIgnored private var tasks: [Task<Void, Never>] = []
    @ObservationIgnored private var preferenceTasks: [String: Task<Void, Never>] = [:]
    /// Bumped by `stop`; answers for an earlier session (a signed-out account) are dropped.
    @ObservationIgnored private var session = 0

    init(tracking: any LiveRunSource, notifications: any NotificationSource) {
        self.tracking = tracking
        self.notifications = notifications
    }

    func start() {
        stop()
        let current = session
        tasks.append(Task { [weak self, tracking] in
            do {
                for try await snapshot in tracking.assignments() {
                    guard let self, self.session == current else { return }
                    self.apply(snapshot)
                }
            } catch {
                self?.fail(session: current)
            }
        })
        tasks.append(Task { [weak self, notifications] in
            do {
                for try await inbox in notifications.alerts() {
                    guard let self, self.session == current else { return }
                    self.apply(inbox: inbox)
                }
            } catch {
                self?.fail(session: current)
            }
        })
    }

    /// Cancels the subscriptions and drops this account's assignments, inbox,
    /// and preferences (docs/13 §5 A10).
    func stop() {
        tasks.forEach { $0.cancel() }
        tasks = []
        preferenceTasks.values.forEach { $0.cancel() }
        preferenceTasks = [:]
        session += 1
        state = .loading
        assignments = []
        alerts = []
        preferences = [:]
        saving = []
        saveFailed = []
    }

    /// The shown choice changes only when the server confirms it.
    func save(assignmentId: String, enabled: Bool, minutes: Int) async {
        guard !saving.contains(assignmentId) else { return }
        let current = session
        saving.insert(assignmentId)
        saveFailed.remove(assignmentId)
        do {
            let saved = try await notifications.savePreference(
                assignmentId: assignmentId, enabled: enabled, minutes: minutes)
            guard session == current else { return }
            preferences[assignmentId] = saved
        } catch {
            guard session == current else { return }
            saveFailed.insert(assignmentId)
        }
        saving.remove(assignmentId)
    }

    private func apply(_ snapshot: AssignmentsSnapshot) {
        switch snapshot {
        case .ready(let list): setAssignments(list)
        case .accessUnavailable: setAssignments([]); state = .unavailable
        }
    }

    private func apply(inbox: [AlertItem]?) {
        if let inbox {
            alerts = inbox
            if state == .loading { state = .ready }
        } else {
            alerts = []
            state = .unavailable
        }
    }

    /// A failure from a stopped session (a signed-out account) is dropped.
    private func fail(session failed: Int) {
        guard failed == session else { return }
        state = .failed
    }

    private func setAssignments(_ list: [AssignmentSummary]) {
        assignments = list
        let ids = Set(list.map(\.assignmentId))
        for (id, task) in preferenceTasks where !ids.contains(id) {
            task.cancel()
            preferenceTasks[id] = nil
            preferences[id] = nil
        }
        for item in list where preferenceTasks[item.assignmentId] == nil {
            let id = item.assignmentId
            let current = session
            preferenceTasks[id] = Task { [weak self, notifications] in
                do {
                    for try await preference in notifications.preference(assignmentId: id) {
                        guard let self, self.session == current else { return }
                        self.preferences[id] = preference
                    }
                } catch {
                    guard let self, self.session == current else { return }
                    self.preferences[id] = nil
                }
            }
        }
    }
}
