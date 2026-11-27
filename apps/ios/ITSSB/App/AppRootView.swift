import ITSSBDesignSystem
import SwiftUI

/// Chooses session restoration, sign-in, or the signed-in tabs (docs/06 §3–4).
/// Tracking exists only while signed in, so signing out ends its subscriptions.
struct AppRootView: View {
    let session: SessionStore
    let source: any LiveRunSource
    let notifications: any NotificationSource
    var registrar: PushRegistrar?
    var initialTab: AppTab = .track

    var body: some View {
        Group {
            switch session.state {
            case .restoring:
                ProgressView("Restoring your session…")
                    .font(AppFonts.body)
                    .foregroundStyle(AppColors.textSecondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .restoreFailed:
                RestoreFailedView { Task { await session.restore() } }
            case .signedOut(.signInUnavailable):
                SignInNotConfiguredView()
            case .signedOut(.notSignedIn):
                SignInView(session: session)
            case .signedIn:
                // "Sign in again" from Track ends the rejected session and returns to sign-in.
                SignedInTabs(source: source, notifications: notifications, registrar: registrar,
                             session: session, initialTab: initialTab) {
                    Task { await session.signOut() }
                }
            }
        }
        .background(AppColors.background)
        .task {
            // Scenario presets start past restoring; only a real launch restores.
            if session.state == .restoring { await session.restore() }
        }
    }
}

enum AppTab: Hashable {
    case track, route, alerts, account
}

/// The four V1 tabs (docs/06 §5). Track, Alerts, and Account are implemented.
struct SignedInTabs: View {
    let source: any LiveRunSource
    let notifications: any NotificationSource
    let registrar: PushRegistrar?
    let session: SessionStore
    @State private var tab: AppTab
    @State private var router = NotificationRouter.shared
    @Environment(\.scenePhase) private var scenePhase
    let onSignIn: () -> Void

    init(source: any LiveRunSource, notifications: any NotificationSource, registrar: PushRegistrar?,
         session: SessionStore, initialTab: AppTab = .track, onSignIn: @escaping () -> Void) {
        self.source = source
        self.notifications = notifications
        self.registrar = registrar
        self.session = session
        _tab = State(initialValue: initialTab)
        self.onSignIn = onSignIn
    }

    var body: some View {
        TabView(selection: $tab) {
            TrackView(source: source, openAssignmentId: router.requestedAssignmentId,
                      onOpened: { router.requestedAssignmentId = nil }, onSignIn: onSignIn)
                .tabItem { Label("Track", systemImage: "bus") }
                .tag(AppTab.track)
            ComingSoon(title: "My Route")
                .tabItem { Label("My Route", systemImage: "map") }
                .tag(AppTab.route)
            AlertsView(tracking: source, notifications: notifications, registrar: registrar)
                .tabItem { Label("Alerts", systemImage: "bell") }
                .tag(AppTab.alerts)
            AccountView(session: session)
                .tabItem { Label("Account", systemImage: "person.crop.circle") }
                .tag(AppTab.account)
        }
        .tint(AppColors.brand)
        // A tapped notification opens Track for its assignment, with current state.
        .onChange(of: router.requestedAssignmentId) { _, id in if id != nil { tab = .track } }
        .task { await registrar?.activate() }
        // Returning from Settings may have changed the permission: re-read and re-register.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await registrar?.refresh() } }
        }
    }
}

/// No identity provider in this build (no Clerk key): say so; show no bus data.
struct SignInNotConfiguredView: View {
    var body: some View {
        ContentUnavailableView {
            Label("Sign-in isn't set up", systemImage: "person.crop.circle.badge.exclamationmark")
                .font(AppFonts.title)
                .foregroundStyle(AppColors.textPrimary)
        } description: {
            Text("This build has no sign-in service configured, so it can't show any bus information.")
                .font(AppFonts.body)
                .foregroundStyle(AppColors.textSecondary)
        }
    }
}

/// The sign-in service couldn't be reached while restoring a saved session.
struct RestoreFailedView: View {
    let onRetry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("Couldn't reach sign-in", systemImage: "wifi.exclamationmark")
                .font(AppFonts.title)
                .foregroundStyle(AppColors.textPrimary)
        } description: {
            Text("Your sign-in couldn't be checked, so bus information is hidden. "
                 + "Check your connection and try again.")
                .font(AppFonts.body)
                .foregroundStyle(AppColors.textSecondary)
        } actions: {
            Button("Try again", action: onRetry)
                .font(AppFonts.headline)
                .buttonStyle(.borderedProminent)
                .tint(AppColors.brand)
                .foregroundStyle(AppColors.onBrand)
        }
    }
}

private struct ComingSoon: View {
    let title: String

    var body: some View {
        ContentUnavailableView(title, systemImage: "hammer", description: Text("Not built yet."))
    }
}
