import ITSSBDesignSystem
import Observation
import SwiftUI

/// Whether an inbox alert still describes the trip (docs/06 I21). An alert is a
/// past estimate: it is never called current unless the live run confirms it.
enum AlertCurrency: Equatable {
    /// The trip's current state hasn't loaded yet.
    case checking
    /// The trip's state couldn't be read (offline, error, or no access).
    case unknown
    /// The alert's trip is no longer running: a different run, or none, is active.
    case tripEnded
    /// The same trip is running and has a newer estimate, made at this time.
    case superseded(newerEstimateAt: Date)
    /// The same trip is running and its estimate is the one this alert used.
    case latest
    /// The same trip is running but has no estimate right now.
    case tripRunningNoEstimate

    /// `snapshot` is the latest `tracking:myRun` for the alert's assignment, nil while loading.
    static func make(alert: AlertItem, snapshot: RunSnapshot?, failed: Bool) -> AlertCurrency {
        if failed { return .unknown }
        switch snapshot {
        case nil:
            return .checking
        case .accessUnavailable:
            return .unknown
        case .noActiveRun:
            return .tripEnded
        case let .ready(assignmentId, _, run, _, _):
            guard assignmentId == alert.assignmentId else { return .unknown }
            // `myRun` only reports an active run; any other run or state means this one is over.
            guard run.runId == alert.runId, run.state == .active else { return .tripEnded }
            guard let eta = run.eta else { return .tripRunningNoEstimate }
            // Wire times are whole milliseconds; allow for Date rounding.
            if eta.generatedAt.timeIntervalSince(alert.predictionGeneratedAt) > 0.001 {
                return .superseded(newerEstimateAt: eta.generatedAt)
            }
            return .latest
        }
    }
}

/// Watches the alert's trip while I21 is open.
@MainActor @Observable
final class AlertDetailViewModel {
    let alert: AlertItem
    private(set) var snapshot: RunSnapshot?
    private(set) var failed = false

    @ObservationIgnored private let tracking: any LiveRunSource
    @ObservationIgnored private var task: Task<Void, Never>?

    init(alert: AlertItem, tracking: any LiveRunSource) {
        self.alert = alert
        self.tracking = tracking
    }

    var currency: AlertCurrency { AlertCurrency.make(alert: alert, snapshot: snapshot, failed: failed) }

    func start() {
        stop()
        let assignmentId = alert.assignmentId
        task = Task { [weak self, tracking] in
            do {
                for try await snapshot in tracking.run(assignmentId: assignmentId) {
                    guard let self, !Task.isCancelled else { return }
                    self.snapshot = snapshot
                    self.failed = false
                }
            } catch {
                guard let self, !Task.isCancelled else { return }
                self.failed = true
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }
}

/// I21 Alert details: where the alert came from, which trip and stop, when it
/// was made, and whether it still describes the trip.
struct AlertDetailView: View {
    @State private var model: AlertDetailViewModel
    let assignment: AssignmentSummary?

    init(alert: AlertItem, assignment: AssignmentSummary?, tracking: any LiveRunSource) {
        _model = State(initialValue: AlertDetailViewModel(alert: alert, tracking: tracking))
        self.assignment = assignment
    }

    var body: some View {
        let alert = model.alert
        List {
            Section {
                CurrencyNotice(currency: model.currency)
            }
            Section("Trip") {
                if let assignment {
                    LabeledContent("Student", value: assignment.studentDisplayName)
                    LabeledContent("Route", value: assignment.routeLabel)
                }
                LabeledContent("Stop", value: alert.stopLabel)
            }
            Section {
                LabeledContent("Estimated arrival", value: time(alert.predictedArrivalAt))
                LabeledContent("Estimate made", value: time(alert.predictionGeneratedAt))
                LabeledContent("Alert sent", value: dateTime(alert.createdAt))
            } header: {
                Text("Estimate")
            } footer: {
                Text("Sent by ITSSB from the bus's reported location. Arrival times are estimates and can change.")
            }
        }
        .font(AppFonts.body)
        .navigationTitle("Bus approaching")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { model.start() }
        .onDisappear { model.stop() }
    }

    private func time(_ date: Date) -> String { StatusCopy.capturedTime(date, timeZone: .current) }
    private func dateTime(_ date: Date) -> String { date.formatted(date: .abbreviated, time: .shortened) }
}

private struct CurrencyNotice: View {
    let currency: AlertCurrency

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: AppSpacing.xxs) {
                Text(title).font(AppFonts.headline).foregroundStyle(AppColors.textPrimary)
                Text(detail).font(AppFonts.callout).foregroundStyle(AppColors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } icon: {
            Image(systemName: systemImage).foregroundStyle(color)
        }
        .accessibilityElement(children: .combine)
    }

    private var title: String {
        switch currency {
        case .checking: "Checking this trip…"
        case .unknown: "Couldn't check this trip"
        case .tripEnded: "This trip has ended"
        case .superseded: "There's a newer estimate"
        case .latest: "This is the trip's latest estimate"
        case .tripRunningNoEstimate: "No current estimate"
        }
    }

    private var detail: String {
        switch currency {
        case .checking: "This alert shows an earlier estimate."
        case .unknown: "This alert shows an earlier estimate. It may be out of date."
        case .tripEnded: "This alert is from a trip that's no longer running."
        case .superseded(let newer):
            "This alert is out of date. Track shows the estimate made at "
                + "\(StatusCopy.capturedTime(newer, timeZone: .current))."
        case .latest: "The trip is still running. Track shows how old the estimate is now."
        case .tripRunningNoEstimate: "The trip is still running, but there's no estimate right now. See Track."
        }
    }

    private var systemImage: String {
        switch currency {
        case .checking: "hourglass"
        case .unknown: "questionmark.circle"
        case .tripEnded: "flag.checkered"
        case .superseded, .tripRunningNoEstimate: "clock.arrow.circlepath"
        case .latest: "checkmark.circle"
        }
    }

    private var color: Color {
        switch currency {
        case .latest: AppColors.statusFresh
        case .superseded, .tripRunningNoEstimate: AppColors.statusAging
        case .checking, .unknown, .tripEnded: AppColors.statusUnknown
        }
    }
}

#Preview {
    NavigationStack {
        AlertDetailView(alert: PreviewFixtures.alert(), assignment: PreviewFixtures.assignment,
                        tracking: PreviewLiveRunSource(scenario: .alerts))
    }
}
