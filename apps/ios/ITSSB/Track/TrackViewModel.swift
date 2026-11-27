import Foundation
import Observation

/// The selected assignment and, once loaded, its approved route geometry.
struct TrackContext: Equatable, Sendable {
    let assignment: AssignmentSummary
    /// Nil until `tracking:myRoute` answers, or if it answered for another route version.
    let route: RouteGeometry?
}

/// Explicit screen states (docs/06 §6). Never show a map that looks live while
/// loading, without a run, or without access. Fresh vs. stale is not stored
/// here: it depends on the clock, so `LivePresentation` derives it at render
/// time and the screen goes stale on its own.
enum TrackState: Equatable {
    case loading
    case tracking(TrackContext, TrackedRun, ServerClock)
    case noActiveRun(TrackContext)
    /// No approved assignment, or access was removed. Protected data is cleared.
    case accessUnavailable
    /// The backend no longer accepts the session. Protected data is cleared.
    case sessionExpired
    /// Recoverable failure. Never presented as "no trip".
    case failed(message: String)
}

/// Owns the selected assignment, its subscriptions, and the resulting state
/// (docs/06 §6 `TrackingStore`).
@MainActor
@Observable
final class TrackViewModel {
    private(set) var state: TrackState = .loading
    private(set) var assignments: [AssignmentSummary] = []
    private(set) var selectedAssignmentId: String?

    private let source: any LiveRunSource
    /// Bumped on every selection change; results from older generations are dropped.
    private var generation = 0
    private var assignmentsTask: Task<Void, Never>?
    private var selectionTask: Task<Void, Never>?
    private var route: RouteGeometry?
    private var runSnapshot: RunSnapshot?

    init(source: any LiveRunSource) {
        self.source = source
    }

    /// Starts (or restarts) the assignment and tracking subscriptions.
    func start() {
        stop()
        state = .loading
        assignmentsTask = Task { await observeAssignments() }
    }

    /// Cancels every subscription and drops protected data.
    func stop() {
        assignmentsTask?.cancel()
        assignmentsTask = nil
        clearSelection()
        assignments = []
    }

    func retry() {
        start()
    }

    /// Switches to another approved assignment (docs/06 §8).
    func select(assignmentId: String) {
        guard assignmentId != selectedAssignmentId,
              assignments.contains(where: { $0.assignmentId == assignmentId }) else { return }
        beginSelection(assignmentId)
    }

    // MARK: Subscriptions

    private func observeAssignments() async {
        do {
            for try await snapshot in source.assignments() {
                guard !Task.isCancelled else { return }
                apply(snapshot)
            }
        } catch {
            guard !Task.isCancelled else { return }
            clearSelection()
            state = Self.state(for: error)
        }
    }

    private func apply(_ snapshot: AssignmentsSnapshot) {
        switch snapshot {
        case .accessUnavailable(let reason):
            assignments = []
            clearSelection()
            state = reason == .unauthenticated ? .sessionExpired : .accessUnavailable
        case .ready(let list):
            assignments = list
            if list.isEmpty {
                clearSelection()
                state = .accessUnavailable
            } else if let selected = selectedAssignmentId, list.contains(where: { $0.assignmentId == selected }) {
                render()
            } else {
                beginSelection(list[0].assignmentId)
            }
        }
    }

    /// docs/06 §8: cancel the old subscription, start a new generation, clear
    /// protected details, enter loading, then subscribe for the new selection.
    private func beginSelection(_ assignmentId: String) {
        clearSelection()
        let current = generation
        selectedAssignmentId = assignmentId
        state = .loading
        selectionTask = Task {
            await withTaskGroup(of: Void.self) { group in
                group.addTask { await self.observeRoute(assignmentId, generation: current) }
                group.addTask { await self.observeRun(assignmentId, generation: current) }
            }
        }
    }

    private func observeRun(_ assignmentId: String, generation current: Int) async {
        do {
            for try await snapshot in source.run(assignmentId: assignmentId) {
                guard isCurrent(current) else { return }
                runSnapshot = snapshot
                render()
            }
        } catch {
            guard isCurrent(current) else { return }
            fail(with: error)
        }
    }

    private func observeRoute(_ assignmentId: String, generation current: Int) async {
        do {
            for try await snapshot in source.route(assignmentId: assignmentId) {
                guard isCurrent(current) else { return }
                switch snapshot {
                case .ready(let geometry):
                    route = geometry.assignmentId == assignmentId ? geometry : nil
                    render()
                case .accessUnavailable(let reason):
                    runSnapshot = .accessUnavailable(reason)
                    render()
                }
            }
        } catch {
            guard isCurrent(current) else { return }
            fail(with: error)
        }
    }

    // MARK: State

    private func render() {
        guard let selected = selectedAssignmentId,
              let assignment = assignments.first(where: { $0.assignmentId == selected }) else { return }
        switch runSnapshot {
        case nil:
            state = .loading
        case let .ready(assignmentId, routeVersionId, run, clock):
            guard assignmentId == selected else { return }
            state = .tracking(context(assignment, routeVersionId: routeVersionId), run, clock)
        case let .noActiveRun(assignmentId, routeVersionId):
            guard assignmentId == selected else { return }
            state = .noActiveRun(context(assignment, routeVersionId: routeVersionId))
        case .accessUnavailable(let reason):
            clearSelection()
            state = reason == .unauthenticated ? .sessionExpired : .accessUnavailable
        }
    }

    /// Only geometry for the run's own route version is drawn.
    private func context(_ assignment: AssignmentSummary, routeVersionId: String) -> TrackContext {
        TrackContext(assignment: assignment, route: route?.routeVersionId == routeVersionId ? route : nil)
    }

    private func fail(with error: Error) {
        clearSelection()
        state = Self.state(for: error)
    }

    private func clearSelection() {
        selectionTask?.cancel()
        selectionTask = nil
        generation += 1
        selectedAssignmentId = nil
        route = nil
        runSnapshot = nil
    }

    private func isCurrent(_ candidate: Int) -> Bool {
        candidate == generation && !Task.isCancelled
    }

    static func state(for error: Error) -> TrackState {
        switch error as? TrackingError {
        case .sessionExpired:
            return .sessionExpired
        case .invalidData:
            return .failed(message: "The tracking service sent data this app couldn't verify, so it isn't shown.")
        case .transport, nil:
            return .failed(message: "Couldn't reach the tracking service. Check your connection and try again.")
        }
    }
}
