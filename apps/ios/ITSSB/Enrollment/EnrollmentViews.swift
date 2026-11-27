import ITSSBDesignSystem
import SwiftUI

/// Screens reachable from My Route. Raw values double as DEBUG screenshot launch names.
enum FamilyScreen: String, Hashable, Sendable {
    case join, link, checkIn, requests
    #if DEBUG
    case joinForm, joinSent, joinRefused, joinUnconfirmed, joinExpired, linkSent, checkInRoute, checkInAccepted
    #endif
}

/// My Route: join a route, link a student, check in, and request status (docs/06 I05–I08, I11, I17–I18).
struct FamilyActionsView: View {
    let source: any EnrollmentSource
    @State private var path: [FamilyScreen]

    init(source: any EnrollmentSource, initialScreen: FamilyScreen? = nil) {
        self.source = source
        _path = State(initialValue: initialScreen.map { [$0] } ?? [])
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    NavigationLink(value: FamilyScreen.join) { Label("Join a route", systemImage: "bus.doubledecker") }
                    NavigationLink(value: FamilyScreen.link) { Label("Link a student", systemImage: "person.2") }
                    NavigationLink(value: FamilyScreen.checkIn) { Label("Check in", systemImage: "qrcode.viewfinder") }
                    NavigationLink(value: FamilyScreen.requests) { Label("My requests", systemImage: "tray") }
                } footer: {
                    Text("The school approves every request. Until then, this account can't see a bus.")
                        .font(AppFonts.caption)
                }
            }
            .navigationTitle("My Route")
            .navigationDestination(for: FamilyScreen.self) { destination($0) }
        }
    }

    @ViewBuilder private func destination(_ screen: FamilyScreen) -> some View {
        switch screen {
        case .join: JoinRouteView(model: JoinRouteViewModel(source: source))
        case .link: LinkStudentView(model: LinkStudentViewModel(source: source))
        case .checkIn: CheckInListView(source: source)
        case .requests: RequestsView(model: RequestsViewModel(source: source))
        #if DEBUG
        default: PreviewScreens.view(screen, source: source)
        #endif
        }
    }
}

/// A server answer that isn't a success, in plain words.
struct OutcomeNotice: View {
    let outcome: CommandOutcome
    var onRetry: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.xs) {
            Text(title).font(AppFonts.headline).foregroundStyle(AppColors.textPrimary)
            Text(detail).font(AppFonts.callout).foregroundStyle(AppColors.textSecondary)
            if outcome == .unconfirmed, let onRetry {
                Button("Try again", action: onRetry)
                    .buttonStyle(.borderedProminent)
                    .tint(AppColors.brand)
                    .foregroundStyle(AppColors.onBrand)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var title: String {
        switch outcome {
        case .problem(let problem): problem.title
        case .refused: "Not accepted"
        case .signedOut: "Signed out"
        case .notPermitted: "Not available for this account"
        case .unconfirmed: "Not confirmed yet"
        case .sent, .recorded: "Sent"
        }
    }

    private var detail: String {
        switch outcome {
        case .problem(let problem): problem.detail
        case .refused(_, let message): message
        case .signedOut: "Sign in again, then send it again. Nothing was sent."
        case .notPermitted: "This account can't do that. Ask your school."
        case .unconfirmed:
            "We couldn't reach the school's system, so we don't know whether it arrived. "
                + "Try again: it won't be sent twice."
        case .sent, .recorded: ""
        }
    }
}

// MARK: Join a route (I05–I08)

struct JoinRouteView: View {
    @State var model: JoinRouteViewModel

    var body: some View {
        ScrollViewReader { proxy in
            Form {
                if model.outcome == .sent {
                    sentSection
                } else {
                    codeSection
                    phaseSection
                }
            }
            // Bring the server's answer into view: it sits below the form.
            .onChange(of: model.outcome) { _, outcome in
                if outcome != nil { withAnimation { proxy.scrollTo(Self.outcomeAnchor, anchor: .bottom) } }
            }
        }
        .navigationTitle("Join a route")
        .task { if model.parsedCode != nil, model.phase == .enterCode { await model.checkCode() } }
    }

    private var codeSection: some View {
        Section {
            TextField("ABCD-EFGH-JKMN-PQRS-TVWX", text: $model.codeText)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .font(AppFonts.numeric)
            Button("Check code") { Task { await model.checkCode() } }
                .disabled(model.parsedCode == nil || model.phase == .checking)
        } header: {
            Text("Route code")
        } footer: {
            Text("From your school or the bus. You'll see bus tracking after the school approves.")
        }
    }

    @ViewBuilder private var phaseSection: some View {
        switch model.phase {
        case .enterCode:
            EmptyView()
        case .checking:
            Section { ProgressView("Checking the code…") }
        case .problem(let problem):
            Section { OutcomeNotice(outcome: .problem(problem)) }
        case .signedOut:
            Section { OutcomeNotice(outcome: .signedOut) }
        case .failed:
            Section { Text("Couldn't check the code. Check your connection and try again.").font(AppFonts.callout) }
        case let .form(_, preview):
            requestForm(preview)
        }
    }

    @ViewBuilder private func requestForm(_ preview: InvitationPreview) -> some View {
        Section {
            Text(preview.routeLabel).font(AppFonts.headline)
            Text(preview.towardSchool ? "To school" : "From school").foregroundStyle(AppColors.textSecondary)
            Text("Code valid until \(preview.expiresAt.formatted(date: .abbreviated, time: .shortened))")
                .font(AppFonts.caption).foregroundStyle(AppColors.textSecondary)
        }
        Section {
            TextField("Student's name", text: $model.studentName).textContentType(.name)
            TextField("Home address", text: $model.address).textContentType(.fullStreetAddress)
        } header: {
            Text("Student")
        } footer: {
            Text("Only school staff see the address. It's used to check the right stop.")
        }
        .onChange(of: model.studentName) { model.edited() }
        .onChange(of: model.address) { model.edited() }
        Section("Pickup stop") {
            ForEach(preview.stops) { stop in
                choiceRow(stop.label, detail: stop.instructions, selected: model.stop == .stop(stop.id)) {
                    model.stop = .stop(stop.id)
                    model.edited()
                }
            }
            choiceRow("None of these fit", detail: "The school will choose", selected: model.stop == .schoolChooses) {
                model.stop = .schoolChooses
                model.edited()
            }
        }
        Section("Note for the school (optional)") {
            TextField("Note", text: $model.note, axis: .vertical)
        }
        Section {
            Button {
                Task { await model.send() }
            } label: {
                Text(model.sending ? "Sending…" : "Send request").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(AppColors.brand)
            .foregroundStyle(AppColors.onBrand)
            .disabled(!model.canSend)
            if let outcome = model.outcome, outcome != .sent {
                OutcomeNotice(outcome: outcome) { Task { await model.send() } }
                    .id(Self.outcomeAnchor)
            }
        }
    }

    private static let outcomeAnchor = "outcome"

    private func choiceRow(_ title: String, detail: String?, selected: Bool,
                           action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: AppSpacing.sm) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(selected ? AppColors.brand : AppColors.textSecondary)
                VStack(alignment: .leading, spacing: AppSpacing.xxs) {
                    Text(title).foregroundStyle(AppColors.textPrimary)
                    if let detail { Text(detail).font(AppFonts.caption).foregroundStyle(AppColors.textSecondary) }
                }
            }
            .frame(minHeight: AppSpacing.touchTarget)
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var sentSection: some View {
        Section {
            Label("Request sent", systemImage: "checkmark.circle").font(AppFonts.headline)
            Text("The school has your request. You'll be able to track the bus once it's approved.")
            Text("Until then, this account can't see the bus.")
                .font(AppFonts.caption).foregroundStyle(AppColors.textSecondary)
        }
    }
}

// MARK: Link a student

struct LinkStudentView: View {
    @State var model: LinkStudentViewModel

    var body: some View {
        Form {
            if model.outcome == .sent {
                Section {
                    Label("Request sent", systemImage: "checkmark.circle").font(AppFonts.headline)
                    Text("The school will check its records. You'll see the student once they approve.")
                }
            } else {
                Section {
                    TextField("ABCD-EFGH-JKMN-PQRS-TVWX", text: $model.codeText)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(AppFonts.numeric)
                } header: {
                    Text("Guardian code")
                } footer: {
                    Text("From the school. Each code works once, for one student.")
                }
                Section("Your name") {
                    TextField("Your name", text: $model.guardianName).textContentType(.name)
                }
                Section {
                    Button {
                        Task { await model.send() }
                    } label: {
                        Text(model.sending ? "Sending…" : "Send link request").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(AppColors.brand)
                    .foregroundStyle(AppColors.onBrand)
                    .disabled(!model.canSend)
                    if let outcome = model.outcome {
                        OutcomeNotice(outcome: outcome) { Task { await model.send() } }
                    }
                }
            }
        }
        .navigationTitle("Link a student")
    }
}

// MARK: My requests

struct RequestsView: View {
    @State var model: RequestsViewModel

    var body: some View {
        content
            .navigationTitle("My requests")
            .task { await model.watch() }
    }

    @ViewBuilder private var content: some View {
        switch model.state {
        case .loading:
            ProgressView("Loading your requests…").frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed:
            ContentUnavailableView("Couldn't load your requests", systemImage: "wifi.exclamationmark",
                                   description: Text("Check your connection. Nothing here is assumed."))
        case .signedOut:
            ContentUnavailableView("Signed out", systemImage: "person.crop.circle.badge.exclamationmark",
                                   description: Text("Sign in again to see your requests."))
        case .ready(let snapshot) where snapshot.enrollment.isEmpty && snapshot.links.isEmpty:
            ContentUnavailableView("No requests yet", systemImage: "tray",
                                   description: Text("Use a route code to join a route, "
                                                     + "or a guardian code to link a student."))
        case .ready(let snapshot):
            List {
                if !snapshot.enrollment.isEmpty {
                    Section("Routes") { ForEach(snapshot.enrollment) { RequestRow(item: $0) } }
                }
                if !snapshot.links.isEmpty {
                    Section("Guardian links") { ForEach(snapshot.links) { LinkRow(item: $0) } }
                }
            }
        }
    }
}

private struct StatusBadge: View {
    let status: RequestStatus

    var body: some View {
        Text(status.text)
            .font(AppFonts.caption)
            .padding(.horizontal, AppSpacing.sm)
            .padding(.vertical, AppSpacing.xxs)
            .background(AppColors.surfaceMuted, in: Capsule())
            .foregroundStyle(AppColors.textPrimary)
    }
}

private struct RequestRow: View {
    let item: EnrollmentRequestItem

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.xs) {
            HStack {
                Text(item.studentName).font(AppFonts.headline)
                Spacer()
                StatusBadge(status: item.status)
            }
            Text("\(item.routeLabel) · \(item.requestedStopLabel ?? "Stop chosen by the school")")
                .font(AppFonts.callout).foregroundStyle(AppColors.textSecondary)
            if item.status == .pending {
                Text("You can't see this bus until the school approves.").font(AppFonts.caption)
            }
            if let reason = item.decisionReason {
                Text("School's reason: \(reason)").font(AppFonts.caption)
            }
        }
        .padding(.vertical, AppSpacing.xs)
    }
}

private struct LinkRow: View {
    let item: LinkRequestItem

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.xs) {
            HStack {
                Text(item.studentDisplayName ?? "Student link").font(AppFonts.headline)
                Spacer()
                StatusBadge(status: item.status)
            }
            if item.status == .pending {
                Text("The school checks its records before approving.").font(AppFonts.caption)
            }
            if let reason = item.decisionReason {
                Text("School's reason: \(reason)").font(AppFonts.caption)
            }
        }
        .padding(.vertical, AppSpacing.xs)
    }
}
