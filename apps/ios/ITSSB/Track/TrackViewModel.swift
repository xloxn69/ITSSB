import Foundation
import Observation

/// The selected assignment and, once loaded, its approved route geometry.
struct TrackContext: Equatable, Sendable {
    let assignment: AssignmentSummary
    /// Nil until `tracking:myRoute` answers, or if it answered for another route version.
    let route: RouteGeometry?
    /// Today's ended trip and calendar notice; the view hides them once their day ends.
    let notices: TripNotices
}

/// Explicit screen states (docs/06 §6). Never show a map that looks live while
/// loading, without a run, or without access. Fresh vs. stale is not stored
/// here: it depends on the clock, so `LivePresentation` derives it at render
/// time and the screen goes stale on its own.
enum TrackState: Equatable {
    case loading
    case tracking(TrackContext, TrackedRun, ServerClock)
    /// The clock decides when today's ended trip or notice expires.
    case noActiveRun(TrackContext, ServerClock)
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
    /// The phone lost its link after having had one (docs/06 I25). While it
    /// is true nothing is shown as fresh and the card says the phone is
    /// reconnecting. Starting up is not "lost".
    private(set) var connectionLost = false

    private let source: any LiveRunSource
    /// Bumped on every selection change; results from older generations are dropped.
    private var generation = 0
    private var assignmentsTask: Task<Void, Never>?
    private var connectionTask: Task<Void, Never>?
    private var selectionTask: Task<Void, Never>?
    private var route: RouteGeometry?
    private var runSnapshot: RunSnapshot?

    init(source: any LiveRunSource) {
        self.source = source
    }

    /// Starts (or restarts) the assignment and tracking subscriptions.
    func start() {
        lifecycleCount += 1
        cancelSubscriptions()
        state = .loading
        assignmentsTask = Task { await observeAssignments() }
        connectionTask = Task { await observeConnection() }
    }

    /// Cancels every subscription and drops protected data, back to the neutral
    /// starting state: after sign-out nothing of this account (assignments, run,
    /// route, a pending notification tap) is left for the next (docs/13 §5 A10).
    func stop() {
        lifecycleCount += 1
        cancelSubscriptions()
        pendingAssignmentId = nil
        state = .loading
    }

    /// A restart keeps a pending notification tap; `stop` drops it.
    private func cancelSubscriptions() {
        assignmentsTask?.cancel()
        assignmentsTask = nil
        connectionTask?.cancel()
        connectionTask = nil
        connectionLost = false
        clearSelection()
        assignments = []
    }

    func retry() {
        start()
    }

    /// Back from the background (docs/06 §12): measure server time again, then
    /// resubscribe, keeping the selected student. Does nothing while Track is stopped.
    func resumeFromBackground() async {
        guard assignmentsTask != nil else { return }
        let lifecycle = lifecycleCount
        await source.reverifyServerTime()
        // Stopped, restarted, or another refresh won while this one waited: it is obsolete.
        guard assignmentsTask != nil, lifecycle == lifecycleCount else { return }
        // Read after the wait, so a notification tap made meanwhile isn't undone.
        let keep = pendingAssignmentId ?? selectedAssignmentId
        start()
        pendingAssignmentId = keep
    }

    /// Bumped by every start and stop.
    private var lifecycleCount = 0

    /// An assignment a tapped notification asked for, kept until assignments load.
    private(set) var pendingAssignmentId: String?

    /// Opens a notification's assignment: now if it is loaded, otherwise once
    /// assignments arrive. An ID that isn't one of this person's approved
    /// assignments is dropped, never selected.
    func open(assignmentId: String) {
        if assignments.contains(where: { $0.assignmentId == assignmentId }) {
            pendingAssignmentId = nil
            select(assignmentId: assignmentId)
        } else {
            pendingAssignmentId = assignmentId
        }
    }

    /// Switches to another approved assignment (docs/06 §8).
    func select(assignmentId: String) {
        guard assignmentId != selectedAssignmentId,
              assignments.contains(where: { $0.assignmentId == assignmentId }) else { return }
        beginSelection(assignmentId)
    }

    // MARK: Subscriptions

    private func observeConnection() async {
        var everConnected = false
        for await connected in source.connection() {
            guard !Task.isCancelled else { return }
            everConnected = everConnected || connected
            connectionLost = everConnected && !connected
        }
    }

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
            let pending = pendingAssignmentId
            pendingAssignmentId = nil
            if let pending, list.contains(where: { $0.assignmentId == pending }) {
                if pending != selectedAssignmentId { beginSelection(pending) } else { render() }
            } else if list.isEmpty {
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
        case let .ready(assignmentId, routeVersionId, run, clock, notices):
            guard assignmentId == selected else { return }
            state = .tracking(context(assignment, routeVersionId: routeVersionId, notices: notices), run, clock)
        case let .noActiveRun(assignmentId, routeVersionId, clock, notices):
            guard assignmentId == selected else { return }
            state = .noActiveRun(context(assignment, routeVersionId: routeVersionId, notices: notices), clock)
        case .accessUnavailable(let reason):
            clearSelection()
            state = reason == .unauthenticated ? .sessionExpired : .accessUnavailable
        }
    }

    /// Only geometry for the run's own route version is drawn.
    private func context(_ assignment: AssignmentSummary, routeVersionId: String,
                         notices: TripNotices) -> TrackContext {
        TrackContext(assignment: assignment, route: route?.routeVersionId == routeVersionId ? route : nil,
                     notices: notices)
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
