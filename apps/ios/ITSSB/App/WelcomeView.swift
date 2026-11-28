import ITSSBDesignSystem
import SwiftUI

/// When I01 Welcome comes before sign-in: only for a signed-out person who
/// hasn't started signing in. A sign-in in progress, an error to read, a
/// signed-in person, or a build without sign-in never sees it.
enum WelcomeGate {
    static func shows(state: SessionState, step: SignInStep, message: String?, isWorking: Bool,
                      dismissed: Bool) -> Bool {
        !dismissed && state == .signedOut(.notSignedIn) && step == .email && message == nil && !isWorking
    }
}

/// I01: what the app does, then Get started or Sign in. Shows no bus data.
struct WelcomeView: View {
    let onContinue: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AppSpacing.xl) {
                VStack(alignment: .leading, spacing: AppSpacing.sm) {
                    Image(systemName: "bus.fill")
                        .font(AppFonts.largeTitle)
                        .foregroundStyle(AppColors.brand)
                        .accessibilityHidden(true)
                    Text("Your school bus, honestly")
                        .font(AppFonts.largeTitle)
                        .foregroundStyle(AppColors.textPrimary)
                }
                VStack(alignment: .leading, spacing: AppSpacing.lg) {
                    point("location.fill", "See where the bus last reported its location, and how long ago.")
                    point("bell.badge", "Get an alert when the bus is getting close to your stop.")
                    point("lock.fill", "Your school approves who can see each route. Nobody else can.")
                }
                Text("An arrival time is an estimate. An old location always says it's old.")
                    .font(AppFonts.callout)
                    .foregroundStyle(AppColors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(AppSpacing.screen)
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: AppSpacing.sm) {
                Button(action: onContinue) {
                    Text("Get started").frame(maxWidth: .infinity, minHeight: AppSpacing.touchTarget)
                }
                .font(AppFonts.headline)
                .buttonStyle(.borderedProminent)
                .tint(AppColors.brand)
                .foregroundStyle(AppColors.onBrand)
                Button(action: onContinue) {
                    Text("Sign in").frame(maxWidth: .infinity, minHeight: AppSpacing.touchTarget)
                }
                .font(AppFonts.headline)
                .tint(AppColors.textPrimary)
                Text("New here? Use your email. Your school approves access before you see a bus.")
                    .font(AppFonts.caption)
                    .foregroundStyle(AppColors.textSecondary)
                    .multilineTextAlignment(.center)
            }
            .padding(AppSpacing.screen)
            .background(AppColors.background)
        }
        .background(AppColors.background)
    }

    private func point(_ systemImage: String, _ text: String) -> some View {
        Label {
            Text(text)
                .font(AppFonts.body)
                .foregroundStyle(AppColors.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: systemImage).foregroundStyle(AppColors.route)
        }
    }
}

#Preview { WelcomeView {} }
