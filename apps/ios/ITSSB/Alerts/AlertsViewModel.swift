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

    init(tracking: any LiveRunSource, notifications: any NotificationSource) {
        self.tracking = tracking
        self.notifications = notifications
    }

    func start() {
        stop()
        state = .loading
        tasks.append(Task { [weak self, tracking] in
            do {
                for try await snapshot in tracking.assignments() {
                    guard let self else { return }
                    switch snapshot {
                    case .ready(let list): self.setAssignments(list)
                    case .accessUnavailable: self.setAssignments([]); self.state = .unavailable
                    }
                }
            } catch {
                self?.state = .failed
            }
        })
        tasks.append(Task { [weak self, notifications] in
            do {
                for try await inbox in notifications.alerts() {
                    guard let self else { return }
                    if let inbox {
                        self.alerts = inbox
                        if self.state == .loading { self.state = .ready }
                    } else {
                        self.alerts = []
                        self.state = .unavailable
                    }
                }
            } catch {
                self?.state = .failed
            }
        })
    }

    func stop() {
        tasks.forEach { $0.cancel() }
        tasks = []
        preferenceTasks.values.forEach { $0.cancel() }
        preferenceTasks = [:]
    }

    /// The shown choice changes only when the server confirms it.
    func save(assignmentId: String, enabled: Bool, minutes: Int) async {
        guard !saving.contains(assignmentId) else { return }
        saving.insert(assignmentId)
        saveFailed.remove(assignmentId)
        do {
            preferences[assignmentId] = try await notifications.savePreference(
                assignmentId: assignmentId, enabled: enabled, minutes: minutes)
        } catch {
            saveFailed.insert(assignmentId)
        }
        saving.remove(assignmentId)
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
            preferenceTasks[id] = Task { [weak self, notifications] in
                do {
                    for try await preference in notifications.preference(assignmentId: id) {
                        self?.preferences[id] = preference
                    }
                } catch {
                    self?.preferences[id] = nil
                }
            }
        }
    }
}
