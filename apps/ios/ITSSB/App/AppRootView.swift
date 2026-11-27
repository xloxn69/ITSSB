import ITSSBDesignSystem
import SwiftUI

/// Chooses session restoration, sign-in, or the signed-in tabs (docs/06 §3–4).
/// Tracking exists only while signed in, so signing out ends its subscriptions.
struct AppRootView: View {
    let session: SessionStore
    let source: any LiveRunSource

    var body: some View {
        Group {
            switch session.state {
            case .restoring:
                ProgressView("Restoring your session…")
                    .font(AppFonts.body)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .signedOut(let reason):
                SignInRequiredView(reason: reason, error: session.signInError) {
                    Task { await session.signIn() }
                }
            case .signedIn:
                SignedInTabs(source: source) { Task { await session.signIn() } }
            }
        }
        .background(AppColors.background)
        .task { await session.restore() }
    }
}

/// The four V1 tabs (docs/06 §5). Only Track is implemented so far.
struct SignedInTabs: View {
    let source: any LiveRunSource
    let onSignIn: () -> Void

    var body: some View {
        TabView {
            TrackView(source: source, onSignIn: onSignIn)
                .tabItem { Label("Track", systemImage: "bus") }
            ComingSoon(title: "My Route")
                .tabItem { Label("My Route", systemImage: "map") }
            ComingSoon(title: "Alerts")
                .tabItem { Label("Alerts", systemImage: "bell") }
            ComingSoon(title: "Account")
                .tabItem { Label("Account", systemImage: "person.crop.circle") }
        }
        .tint(AppColors.brand)
    }
}

/// I28 for a missing session: sign in, or explain why this build can't.
struct SignInRequiredView: View {
    let reason: SignedOutReason
    let error: String?
    let onSignIn: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label(reason == .signInUnavailable ? "Sign-in isn't available yet" : "Sign in to see your bus",
                  systemImage: "person.crop.circle.badge.exclamationmark")
        } description: {
            Text(reason == .signInUnavailable
                 ? "This build has no sign-in provider configured, so it can't show any bus information."
                 : error ?? "Bus locations are only shown to students and guardians the school has approved.")
        } actions: {
            if reason == .notSignedIn {
                Button("Sign in", action: onSignIn)
                    .buttonStyle(.borderedProminent)
                    .tint(AppColors.brand)
                    .foregroundStyle(AppColors.onBrand)
            }
        }
    }
}

private struct ComingSoon: View {
    let title: String

    var body: some View {
        ContentUnavailableView(title, systemImage: "hammer", description: Text("Not built yet."))
    }
}
