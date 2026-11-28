import Foundation
import Observation

/// I13: the selected assignment's approved route geometry and stop, read-only,
/// from `tracking:myAssignments` and `tracking:myRoute`. No live bus here.
@MainActor @Observable
final class MyRouteViewModel {
    enum State: Equatable {
        case loading
        case ready(AssignmentSummary, RouteGeometry)
        /// No approved assignment, or access was removed.
        case unavailable
        case sessionExpired
        case failed
    }

    private(set) var state: State = .loading
    private(set) var assignments: [AssignmentSummary] = []
    private(set) var selectedAssignmentId: String?

    @ObservationIgnored private let source: any LiveRunSource
    /// Cancels both subscriptions when the model goes away, so a pushed Stop
    /// details screen keeps them alive and nothing outlives the whole flow.
    @ObservationIgnored private let tasks = SubscriptionTasks()
    @ObservationIgnored private var assignmentsTask: Task<Void, Never>? {
        get { tasks.assignments }
        set { tasks.assignments = newValue }
    }
    @ObservationIgnored private var routeTask: Task<Void, Never>? {
        get { tasks.route }
        set { tasks.route = newValue }
    }
    /// Bumped on every selection change; older route answers are dropped.
    @ObservationIgnored private var generation = 0

    init(source: any LiveRunSource) {
        self.source = source
    }

    /// Starts once; later appearances (returning from Stop details) keep the live subscriptions.
    func startIfNeeded() {
        if assignmentsTask == nil { start() }
    }

    /// The assigned stop while access is current; nil as soon as it isn't (I14 follows this).
    func currentStop(id stopId: String) -> (stop: AssignedStop, routeLabel: String)? {
        guard case let .ready(_, route) = state, route.assignedStop.stopId == stopId else { return nil }
        return (route.assignedStop, route.routeLabel)
    }

    func start() {
        stop()
        state = .loading
        assignmentsTask = Task { [weak self, source] in
            do {
                for try await snapshot in source.assignments() {
                    guard let self, !Task.isCancelled else { return }
                    self.apply(snapshot)
                }
            } catch {
                guard let self, !Task.isCancelled else { return }
                self.clearRoute()
                self.state = (error as? TrackingError) == .sessionExpired ? .sessionExpired : .failed
            }
        }
    }

    func stop() {
        assignmentsTask?.cancel()
        assignmentsTask = nil
        clearRoute()
        assignments = []
    }

    func select(assignmentId: String) {
        guard assignmentId != selectedAssignmentId,
              assignments.contains(where: { $0.assignmentId == assignmentId }) else { return }
        observeRoute(assignmentId)
    }

    private func apply(_ snapshot: AssignmentsSnapshot) {
        switch snapshot {
        case .accessUnavailable(let reason):
            assignments = []
            clearRoute()
            state = reason == .unauthenticated ? .sessionExpired : .unavailable
        case .ready(let list):
            assignments = list
            if list.isEmpty {
                clearRoute()
                state = .unavailable
            } else if let selected = selectedAssignmentId, list.contains(where: { $0.assignmentId == selected }) {
                if case let .ready(_, route) = state, let summary = list.first(where: { $0.assignmentId == selected }) {
                    state = .ready(summary, route)
                }
            } else {
                observeRoute(list[0].assignmentId)
            }
        }
    }

    private func observeRoute(_ assignmentId: String) {
        clearRoute()
        let current = generation
        selectedAssignmentId = assignmentId
        state = .loading
        routeTask = Task { [weak self, source] in
            do {
                for try await snapshot in source.route(assignmentId: assignmentId) {
                    guard let self, self.isCurrent(current) else { return }
                    self.render(snapshot, for: assignmentId)
                }
            } catch {
                guard let self, self.isCurrent(current) else { return }
                self.clearRoute()
                self.state = (error as? TrackingError) == .sessionExpired ? .sessionExpired : .failed
            }
        }
    }

    private func render(_ snapshot: RouteSnapshot, for assignmentId: String) {
        switch snapshot {
        case .ready(let geometry):
            // Geometry for another assignment is never drawn under this student's name.
            guard geometry.assignmentId == assignmentId,
                  let summary = assignments.first(where: { $0.assignmentId == assignmentId }) else { return }
            state = .ready(summary, geometry)
        case .accessUnavailable(let reason):
            clearRoute()
            state = reason == .unauthenticated ? .sessionExpired : .unavailable
        }
    }

    private func clearRoute() {
        routeTask?.cancel()
        routeTask = nil
        generation += 1
        selectedAssignmentId = nil
    }

    private func isCurrent(_ candidate: Int) -> Bool {
        candidate == generation && !Task.isCancelled
    }
}

/// Holds the subscription tasks and cancels them when released.
private final class SubscriptionTasks: @unchecked Sendable {
    var assignments: Task<Void, Never>?
    var route: Task<Void, Never>?

    deinit {
        assignments?.cancel()
        route?.cancel()
    }
}
