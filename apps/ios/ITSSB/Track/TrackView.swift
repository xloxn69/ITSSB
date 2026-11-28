import ITSSBDesignSystem
import SwiftUI

/// I09/I12 tracking and its honest alternatives: I25 stale, I26 GPS
/// unavailable, I27 no active trip, I28 session or access unavailable.
struct TrackView: View {
    @State private var model: TrackViewModel
    /// From a tapped notification. Selected only if it is one of this person's assignments.
    let openAssignmentId: String?
    /// Called once the requested assignment has been handed to the model.
    var onOpened: () -> Void = {}
    let onSignIn: () -> Void
    @Environment(\.scenePhase) private var scenePhase
    @State private var foreground = ForegroundRefresh()
    /// For the student's own check-in from the trip (I12, I16). Nil hides it.
    let enrollment: (any EnrollmentSource)?
    private let source: any LiveRunSource
    /// I10: a guardian with two or more students starts on the dashboard.
    @State private var showsDashboard = true
    @State private var checkingIn = false

    init(source: any LiveRunSource, enrollment: (any EnrollmentSource)? = nil, openAssignmentId: String? = nil,
         onOpened: @escaping () -> Void = {}, onSignIn: @escaping () -> Void = {}) {
        _model = State(initialValue: TrackViewModel(source: source))
        self.source = source
        self.enrollment = enrollment
        self.openAssignmentId = openAssignmentId
        self.onOpened = onOpened
        self.onSignIn = onSignIn
    }

    var body: some View {
        Group {
            if showsDashboard, model.assignments.count > 1 {
                GuardianDashboardView(source: source, assignments: model.assignments) { id in
                    model.select(assignmentId: id)
                    showsDashboard = false
                }
            } else {
                content
            }
        }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(AppColors.background)
            .onAppear { model.start() }
            .onDisappear { model.stop() }
            .onChange(of: scenePhase) { _, phase in
                if foreground.shouldRefresh(on: phase) { Task { await model.resumeFromBackground() } }
            }
            // Also runs on first appearance, so a tap that cold-launched the app is kept.
            .task(id: openAssignmentId) {
                guard let id = openAssignmentId else { return }
                showsDashboard = false
                model.open(assignmentId: id)
                onOpened()
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .loading:
            ProgressView("Finding your bus…")
                .font(AppFonts.body)
                .foregroundStyle(AppColors.textSecondary)
        case let .tracking(context, run, clock):
            TrackingScreen(context: context, run: run, clock: clock, picker: picker,
                           connectionLost: model.connectionLost,
                           checkIn: enrollment == nil ? .none
                               : CheckInEntry.make(relationship: context.assignment.relationship, run: run),
                           onCheckIn: { checkingIn = true })
                .sheet(isPresented: $checkingIn) {
                    if let enrollment {
                        NavigationStack {
                            CheckInView(model: CheckInViewModel(
                                source: enrollment,
                                assignment: OwnAssignment(id: context.assignment.assignmentId,
                                                          routeLabel: context.assignment.routeLabel)))
                            .toolbar { Button("Done") { checkingIn = false } }
                        }
                    }
                }
        case let .noActiveRun(context, clock):
            NoActiveRunScreen(context: context, clock: clock, picker: picker)
        case .accessUnavailable:
            StateMessage(title: "Tracking not available", systemImage: "lock.fill",
                         detail: "This account isn't linked to an approved route, or that access was removed. "
                             + "Your school can approve or restore it.")
        case .sessionExpired:
            StateMessage(title: "You're signed out", systemImage: "person.crop.circle.badge.exclamationmark",
                         detail: "Your session ended, so bus information is hidden. Sign in again to continue.",
                         action: ("Sign in again", onSignIn))
        case .failed(let text):
            StateMessage(title: "Couldn't load your bus", systemImage: "wifi.exclamationmark",
                         detail: text, action: ("Try again", { model.retry() }))
        }
    }

    /// Student switcher for guardians with more than one linked student.
    private var picker: AssignmentPicker {
        AssignmentPicker(assignments: model.assignments, selected: model.selectedAssignmentId,
                         onShowAll: { showsDashboard = true }) {
            model.select(assignmentId: $0)
        }
    }
}

// MARK: Screens

private struct TrackingScreen: View {
    let context: TrackContext
    let run: TrackedRun
    let clock: ServerClock
    let picker: AssignmentPicker
    let connectionLost: Bool
    var checkIn: CheckInEntry = .none
    var onCheckIn: () -> Void = {}

    var body: some View {
        // Re-derive every second: age advances and stale arrives with no new update.
        TimelineView(.periodic(from: .now, by: 1)) { timeline in
            let presentation = LivePresentation.make(run: run, clock: clock, now: timeline.date)
                .whileDisconnected(connectionLost)
            BusMapView(route: context.route, stop: run.assignedStop,
                       bus: presentation.showsMarker ? run.position : nil,
                       busLabel: run.busLabel, dimsBus: presentation.dimsMarker)
                .safeAreaInset(edge: .top) { TripHeader(context: context, picker: picker) }
                .safeAreaInset(edge: .bottom) {
                    VStack(spacing: 0) {
                        CheckInButton(entry: checkIn, action: onCheckIn)
                        TripStatusCard(copy: StatusCopy.make(presentation, run: run, clock: clock,
                                                             now: timeline.date, connectionLost: connectionLost),
                                       stopLabel: run.assignedStop.label,
                                       eta: EtaPresentation.make(run: run, clock: clock, now: timeline.date),
                                       progress: EtaPresentation.stopProgress(run),
                                       notice: context.notices.current(at: clock.ageClock(at: timeline.date))
                                           .serviceNotice,
                                       delay: ReportedDelayPresentation.line(run: run, clock: clock,
                                                                             now: timeline.date))
                    }
                }
        }
    }
}

/// I19/I27: today's cancelled or completed trip, a calendar notice, or no
/// trip. There is never a bus marker.
private struct NoActiveRunScreen: View {
    let context: TrackContext
    let clock: ServerClock
    let picker: AssignmentPicker

    var body: some View {
        Group {
            if let route = context.route {
                // The approved route and stop stay useful; there is no bus marker.
                BusMapView(route: route, stop: route.assignedStop, bus: nil)
            } else {
                AppColors.background
            }
        }
        .safeAreaInset(edge: .top) { TripHeader(context: context, picker: picker) }
        .safeAreaInset(edge: .bottom) {
            // Re-derived so yesterday's status leaves the screen when its day ends.
            TimelineView(.periodic(from: .now, by: 1)) { timeline in
                let notices = context.notices.current(at: clock.ageClock(at: timeline.date))
                TripStatusCard(copy: StatusCopy.noTrip(notices), stopLabel: context.assignment.stopLabel,
                               // The notice is the title when nothing ended; otherwise it sits below.
                               notice: notices.endedRun == nil ? nil : notices.serviceNotice)
            }
        }
    }
}

// MARK: Pieces

/// Keeps the selected student visible so a map is never shown under the wrong name.
private struct TripHeader: View {
    let context: TrackContext
    let picker: AssignmentPicker

    var body: some View {
        HStack(spacing: AppSpacing.md) {
            VStack(alignment: .leading, spacing: AppSpacing.xxs) {
                Text(context.assignment.studentDisplayName)
                    .font(AppFonts.headline)
                    .foregroundStyle(AppColors.textPrimary)
                Text(context.assignment.routeLabel)
                    .font(AppFonts.caption)
                    .foregroundStyle(AppColors.textSecondary)
            }
            Spacer()
            if picker.assignments.count > 1 { picker }
        }
        .cardStyle()
        .padding(.horizontal, AppSpacing.screen)
        .accessibilityElement(children: .combine)
    }
}

struct AssignmentPicker: View {
    let assignments: [AssignmentSummary]
    let selected: String?
    /// Opens the I10 dashboard, when there is one.
    var onShowAll: (() -> Void)?
    let onSelect: (String) -> Void

    var body: some View {
        Menu {
            if let onShowAll {
                Button("All students", systemImage: "list.bullet", action: onShowAll)
            }
            ForEach(assignments) { item in
                Button(item.studentDisplayName) { onSelect(item.assignmentId) }
                    .disabled(item.assignmentId == selected)
            }
        } label: {
            Label("Switch student", systemImage: "person.2")
                .font(AppFonts.callout)
        }
        .tint(AppColors.textPrimary)
    }
}

struct TripStatusCard: View {
    let copy: StatusCopy
    let stopLabel: String
    var eta: EtaPresentation?
    var progress: String?
    /// Today's service-calendar notice from the school, when it isn't the title.
    var notice: ServiceNotice?
    var delay: String?

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.sm) {
            HStack(alignment: .firstTextBaseline, spacing: AppSpacing.md) {
                Image(systemName: copy.systemImage)
                    .foregroundStyle(color)
                VStack(alignment: .leading, spacing: AppSpacing.xxs) {
                    Text(copy.title)
                        .font(AppFonts.headline)
                        .foregroundStyle(AppColors.textPrimary)
                    if let age = copy.age {
                        Text(age)
                            .font(AppFonts.numeric)
                            .foregroundStyle(color)
                    }
                }
            }
            Text(copy.detail)
                .font(AppFonts.callout)
                .foregroundStyle(AppColors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            if let progress {
                Text(progress)
                    .font(AppFonts.callout)
                    .foregroundStyle(AppColors.textPrimary)
            }
            if let delay {
                Text(delay)
                    .font(AppFonts.callout)
                    .foregroundStyle(AppColors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let eta {
                VStack(alignment: .leading, spacing: AppSpacing.xxs) {
                    Text("Estimated arrival at your stop")
                        .font(AppFonts.caption)
                        .foregroundStyle(AppColors.textSecondary)
                    Text("\(eta.headline) · around \(eta.arrivalText)")
                        .font(AppFonts.headline)
                        .foregroundStyle(AppColors.textPrimary)
                    Text("\(eta.madeText). Estimates can change.")
                        .font(AppFonts.caption)
                        .foregroundStyle(AppColors.textSecondary)
                }
            }
            if let notice {
                VStack(alignment: .leading, spacing: AppSpacing.xxs) {
                    Text("From your school")
                        .font(AppFonts.caption)
                        .foregroundStyle(AppColors.textSecondary)
                    Text(StatusCopy.noticeTitle(notice))
                        .font(AppFonts.headline)
                        .foregroundStyle(AppColors.textPrimary)
                    Text(notice.notice)
                        .font(AppFonts.callout)
                        .foregroundStyle(AppColors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Label("Your stop: \(stopLabel)", systemImage: "figure.wave")
                .font(AppFonts.caption)
                .foregroundStyle(AppColors.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle()
        .padding(AppSpacing.screen)
        .accessibilityElement(children: .combine)
    }

    private var color: Color {
        switch copy.tone {
        case .fresh: AppColors.statusFresh
        case .aging: AppColors.statusAging
        case .stale: AppColors.statusStale
        case .unknown: AppColors.statusUnknown
        }
    }
}

/// I12/I16: the student's own check-in, from the trip. Emphasized at the stop.
private struct CheckInButton: View {
    let entry: CheckInEntry
    let action: () -> Void

    var body: some View {
        switch entry {
        case .none:
            EmptyView()
        case .available:
            Button(action: action) { Label("Check in", systemImage: "qrcode.viewfinder") }
                .font(AppFonts.callout)
                .buttonStyle(.borderedProminent)
                .tint(AppColors.surface)
                .foregroundStyle(AppColors.textPrimary)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.horizontal, AppSpacing.screen)
        case .atStop:
            Button(action: action) {
                Label("The bus is at your stop. Check in", systemImage: "qrcode.viewfinder")
                    .frame(maxWidth: .infinity, minHeight: AppSpacing.touchTarget)
            }
            .font(AppFonts.headline)
            .buttonStyle(.borderedProminent)
            .tint(AppColors.brand)
            .foregroundStyle(AppColors.onBrand)
            .padding(.horizontal, AppSpacing.screen)
        }
    }
}

private struct StateMessage: View {
    let title: String
    let systemImage: String
    let detail: String
    var action: (String, () -> Void)?

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
                .font(AppFonts.title)
                .foregroundStyle(AppColors.textPrimary)
        } description: {
            Text(detail)
                .font(AppFonts.body)
                .foregroundStyle(AppColors.textSecondary)
        } actions: {
            if let action {
                Button(action.0, action: action.1)
                    .font(AppFonts.headline)
                    .buttonStyle(.borderedProminent)
                    .tint(AppColors.brand)
                    .foregroundStyle(AppColors.onBrand)
            }
        }
    }
}

// MARK: Previews (one per state, fictional data)

#Preview("Live") { TrackView(source: PreviewLiveRunSource(scenario: .live)) }
#Preview("ETA") { TrackView(source: PreviewLiveRunSource(scenario: .eta)) }
#Preview("At stop") { TrackView(source: PreviewLiveRunSource(scenario: .atStop)) }
#Preview("Aging") { TrackView(source: PreviewLiveRunSource(scenario: .aging)) }
#Preview("Stale") { TrackView(source: PreviewLiveRunSource(scenario: .stale)) }
#Preview("Awaiting position") { TrackView(source: PreviewLiveRunSource(scenario: .awaitingPosition)) }
#Preview("GPS unavailable") { TrackView(source: PreviewLiveRunSource(scenario: .gpsUnavailable)) }
#Preview("No active run") { TrackView(source: PreviewLiveRunSource(scenario: .noActiveRun)) }
#Preview("Cancelled") { TrackView(source: PreviewLiveRunSource(scenario: .cancelled)) }
#Preview("Replacement pending") { TrackView(source: PreviewLiveRunSource(scenario: .replacementPending)) }
#Preview("Completed") { TrackView(source: PreviewLiveRunSource(scenario: .completed)) }
#Preview("No service") { TrackView(source: PreviewLiveRunSource(scenario: .noService)) }
#Preview("Late start") { TrackView(source: PreviewLiveRunSource(scenario: .lateStart)) }
#Preview("Loading") { TrackView(source: PreviewLiveRunSource(scenario: .loading)) }
#Preview("Access unavailable") { TrackView(source: PreviewLiveRunSource(scenario: .accessUnavailable)) }
#Preview("Session expired") { TrackView(source: PreviewLiveRunSource(scenario: .sessionExpired)) }
#Preview("Failed") { TrackView(source: PreviewLiveRunSource(scenario: .failed)) }
#Preview("Sign-in not set up") { SignInNotConfiguredView() }
