import ITSSBDesignSystem
import Observation
import SwiftUI

/// One linked student's line on I10, derived at render time so ages advance
/// and a position goes stale without another update.
struct DashboardRow: Equatable {
    enum Tone: Equatable { case fresh, aging, stale, unknown }

    let status: String
    let detail: String?
    let tone: Tone

    static func make(snapshot: RunSnapshot?, failed: Bool, now: Date, connectionLost: Bool = false) -> DashboardRow {
        if failed { return DashboardRow(status: "Couldn't load this trip", detail: nil, tone: .unknown) }
        if connectionLost { return offline(snapshot, now: now) }
        return online(snapshot, now: now)
    }

    /// Subscriptions go quiet offline: "no trip" or "running" may no longer be true (I25).
    private static func offline(_ snapshot: RunSnapshot?, now: Date) -> DashboardRow {
        let age: String? = if case let .ready(_, _, run, clock, _) = snapshot, let position = run.position {
            AgeFormatter.updatedText(age: position.age(at: now, clock: clock))
        } else { nil }
        return DashboardRow(status: "Can't confirm right now",
                            detail: age.map { "Reconnecting… \($0)" } ?? "Reconnecting…", tone: .unknown)
    }

    private static func online(_ snapshot: RunSnapshot?, now: Date) -> DashboardRow {
        switch snapshot {
        case nil:
            return DashboardRow(status: "Checking…", detail: nil, tone: .unknown)
        case .accessUnavailable:
            return DashboardRow(status: "Not available", detail: "Access to this route was removed.", tone: .unknown)
        case .noActiveRun:
            return DashboardRow(status: "No trip right now", detail: nil, tone: .unknown)
        case let .ready(_, _, run, clock, _):
            guard let position = run.position else {
                return DashboardRow(status: "Trip running", detail: "Waiting for the bus's location", tone: .unknown)
            }
            let updated = AgeFormatter.updatedText(age: position.age(at: now, clock: clock))
            switch position.freshness(at: now, clock: clock) {
            case .fresh: return DashboardRow(status: "Trip running", detail: updated, tone: .fresh)
            case .aging: return DashboardRow(status: "Trip running", detail: updated, tone: .aging)
            case .stale: return DashboardRow(status: "Last known location", detail: updated, tone: .stale)
            }
        }
    }
}

/// Watches every approved assignment's own run for I10. Each row only ever
/// holds its own assignment's answer.
@MainActor @Observable
final class GuardianDashboardModel {
    private(set) var snapshots: [String: RunSnapshot] = [:]
    private(set) var failed: Set<String> = []
    /// The phone's link dropped after it had one.
    private(set) var connectionLost = false
    @ObservationIgnored private var connectionTask: Task<Void, Never>?

    @ObservationIgnored private let source: any LiveRunSource
    @ObservationIgnored private var tasks: [String: Task<Void, Never>] = [:]

    init(source: any LiveRunSource) {
        self.source = source
    }

    /// Starts watching new assignments and stops (and forgets) removed ones.
    func update(assignmentIds: [String]) {
        if connectionTask == nil, !assignmentIds.isEmpty { watchConnection() }
        let wanted = Set(assignmentIds)
        for (id, task) in tasks where !wanted.contains(id) {
            task.cancel()
            tasks[id] = nil
            snapshots[id] = nil
            failed.remove(id)
        }
        for id in assignmentIds where tasks[id] == nil {
            tasks[id] = Task { [weak self, source] in
                do {
                    for try await snapshot in source.run(assignmentId: id) {
                        guard let self, !Task.isCancelled else { return }
                        if case let .ready(assignmentId, _, _, _, _) = snapshot, assignmentId != id { continue }
                        if case let .noActiveRun(assignmentId, _, _, _) = snapshot, assignmentId != id { continue }
                        self.snapshots[id] = snapshot
                        self.failed.remove(id)
                    }
                } catch {
                    guard let self, !Task.isCancelled else { return }
                    self.failed.insert(id)
                }
            }
        }
    }

    private func watchConnection() {
        connectionTask = Task { [weak self, source] in
            var everConnected = false
            for await connected in source.connection() {
                guard let self, !Task.isCancelled else { return }
                everConnected = everConnected || connected
                self.connectionLost = everConnected && !connected
            }
        }
    }

    func stop() {
        update(assignmentIds: [])
        connectionTask?.cancel()
        connectionTask = nil
        connectionLost = false
    }
}

/// I10 Guardian dashboard: every approved linked student and their own trip.
struct GuardianDashboardView: View {
    let assignments: [AssignmentSummary]
    @State private var model: GuardianDashboardModel
    let onSelect: (String) -> Void

    init(source: any LiveRunSource, assignments: [AssignmentSummary], onSelect: @escaping (String) -> Void) {
        _model = State(initialValue: GuardianDashboardModel(source: source))
        self.assignments = assignments
        self.onSelect = onSelect
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { timeline in
            List(assignments) { assignment in
                let row = DashboardRow.make(snapshot: model.snapshots[assignment.assignmentId],
                                            failed: model.failed.contains(assignment.assignmentId),
                                            now: timeline.date, connectionLost: model.connectionLost)
                Button { onSelect(assignment.assignmentId) } label: {
                    StudentRow(assignment: assignment, row: row)
                }
                .tint(AppColors.textPrimary)
            }
        }
        .safeAreaInset(edge: .top) {
            Text("Your students")
                .font(AppFonts.title)
                .foregroundStyle(AppColors.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, AppSpacing.screen)
                .padding(.top, AppSpacing.sm)
        }
        .onAppear { model.update(assignmentIds: assignments.map(\.assignmentId)) }
        .onChange(of: assignments.map(\.assignmentId)) { _, ids in model.update(assignmentIds: ids) }
        .onDisappear { model.stop() }
    }
}

private struct StudentRow: View {
    let assignment: AssignmentSummary
    let row: DashboardRow

    var body: some View {
        HStack(spacing: AppSpacing.md) {
            VStack(alignment: .leading, spacing: AppSpacing.xxs) {
                Text(assignment.studentDisplayName)
                    .font(AppFonts.headline)
                    .foregroundStyle(AppColors.textPrimary)
                Text("\(assignment.routeLabel) · \(assignment.stopLabel)")
                    .font(AppFonts.caption)
                    .foregroundStyle(AppColors.textSecondary)
                Text(row.status)
                    .font(AppFonts.callout)
                    .foregroundStyle(AppColors.textPrimary)
                if let detail = row.detail {
                    Text(detail)
                        .font(AppFonts.numeric)
                        .foregroundStyle(color)
                }
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(AppFonts.caption)
                .foregroundStyle(AppColors.textSecondary)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
    }

    private var color: Color {
        switch row.tone {
        case .fresh: AppColors.statusFresh
        case .aging: AppColors.statusAging
        case .stale: AppColors.statusStale
        case .unknown: AppColors.textSecondary
        }
    }
}

/// When Track offers the student's own check-in (docs/06 I12, I16). Guardians
/// never check a student in, and there is nothing to check in to without a running trip.
enum CheckInEntry: Equatable {
    case none
    case available
    /// The bus reports it is at the student's stop: check-in is emphasized.
    case atStop

    static func make(relationship: AssignmentSummary.Relationship, run: TrackedRun) -> CheckInEntry {
        guard relationship == .self, run.state == .active else { return .none }
        return run.assignedStop.status == .atStop ? .atStop : .available
    }
}
