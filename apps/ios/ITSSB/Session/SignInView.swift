import AuthenticationServices
import ITSSBDesignSystem
import SwiftUI

/// I02 email sign-in and I03 code verification, plus Sign in with Apple.
/// Signing in proves who someone is; what they may see is decided by the school.
struct SignInView: View {
    let session: SessionStore
    @State private var email = ""
    @State private var code = ""
    @FocusState private var focused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AppSpacing.xl) {
                header
                switch session.step {
                case .email: emailStep
                case .code(let address): codeStep(address)
                }
                if let message = session.message {
                    Label(message, systemImage: "exclamationmark.circle.fill")
                        .font(AppFonts.callout)
                        .foregroundStyle(AppColors.statusStale)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isStaticText)
                }
            }
            .padding(AppSpacing.screen)
            .padding(.top, AppSpacing.xxl)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(AppColors.background)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: AppSpacing.sm) {
            Image(systemName: "bus.fill")
                .font(AppFonts.title)
                .foregroundStyle(AppColors.onBrand)
                .padding(AppSpacing.md)
                .background(AppColors.brand, in: .rect(cornerRadius: AppRadius.md, style: .continuous))
                .accessibilityHidden(true)
            Text("Sign in")
                .font(AppFonts.largeTitle)
                .foregroundStyle(AppColors.textPrimary)
            Text("Bus locations are shown only to students and guardians your school has approved.")
                .font(AppFonts.body)
                .foregroundStyle(AppColors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var emailStep: some View {
        VStack(alignment: .leading, spacing: AppSpacing.lg) {
            field("Email address", text: $email)
                .keyboardType(.emailAddress)
                .textContentType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.continue)
                .onSubmit(sendCode)
            PrimaryButton(title: "Email me a code", isWorking: session.isWorking, action: sendCode)
            HStack(spacing: AppSpacing.md) {
                Rectangle().fill(AppColors.border).frame(height: AppSpacing.xxs / 2)
                Text("or").font(AppFonts.caption).foregroundStyle(AppColors.textSecondary)
                Rectangle().fill(AppColors.border).frame(height: AppSpacing.xxs / 2)
            }
            .accessibilityHidden(true)
            AppleSignInButton {
                Task { await session.signInWithApple() }
            }
            .frame(height: AppSpacing.touchTarget)
            .disabled(session.isWorking)
        }
    }

    private func codeStep(_ address: String) -> some View {
        VStack(alignment: .leading, spacing: AppSpacing.lg) {
            Text("Enter the code we sent to \(address).")
                .font(AppFonts.body)
                .foregroundStyle(AppColors.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            field("6-digit code", text: $code)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .font(AppFonts.numeric)
                .onSubmit(verify)
            PrimaryButton(title: "Verify and sign in", isWorking: session.isWorking, action: verify)
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let wait = session.resendAvailableAt.map { Int($0.timeIntervalSince(context.date).rounded(.up)) } ?? 0
                Button(wait > 0 ? "Send a new code in \(wait)s" : "Send a new code") {
                    Task { await session.resendCode() }
                }
                .font(AppFonts.callout)
                .disabled(wait > 0 || session.isWorking)
            }
            Button("Use a different email") {
                code = ""
                session.changeEmail()
            }
            .font(AppFonts.callout)
            .disabled(session.isWorking)
        }
        .tint(AppColors.textPrimary)
    }

    private func field(_ title: String, text: Binding<String>) -> some View {
        TextField(title, text: text)
            .font(AppFonts.body)
            .foregroundStyle(AppColors.textPrimary)
            .padding(AppSpacing.md)
            .frame(minHeight: AppSpacing.touchTarget)
            .background(AppColors.surface, in: .rect(cornerRadius: AppRadius.md, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: AppRadius.md, style: .continuous)
                .stroke(AppColors.border, lineWidth: AppSpacing.xxs / 2))
            .focused($focused)
            .disabled(session.isWorking)
    }

    private func sendCode() {
        Task { await session.submitEmail(email) }
    }

    private func verify() {
        Task { await session.submitCode(code) }
    }
}

private struct PrimaryButton: View {
    let title: String
    let isWorking: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: AppSpacing.sm) {
                if isWorking { ProgressView().tint(AppColors.onBrand) }
                Text(isWorking ? "Please wait…" : title).font(AppFonts.headline)
            }
            .frame(maxWidth: .infinity, minHeight: AppSpacing.touchTarget)
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.roundedRectangle(radius: AppRadius.md))
        .tint(AppColors.brand)
        .foregroundStyle(AppColors.onBrand)
        .disabled(isWorking)
    }
}

/// Apple's own Sign in with Apple button (required styling), adapting to light and dark.
private struct AppleSignInButton: UIViewRepresentable {
    @Environment(\.colorScheme) private var colorScheme
    let action: () -> Void

    func makeUIView(context: Context) -> ASAuthorizationAppleIDButton {
        let button = ASAuthorizationAppleIDButton(type: .signIn, style: colorScheme == .dark ? .white : .black)
        button.cornerRadius = AppRadius.md
        button.addTarget(context.coordinator, action: #selector(Coordinator.tapped), for: .touchUpInside)
        return button
    }

    func updateUIView(_ uiView: ASAuthorizationAppleIDButton, context: Context) {
        context.coordinator.action = action
    }

    func makeCoordinator() -> Coordinator { Coordinator(action: action) }

    final class Coordinator: NSObject {
        var action: () -> Void
        init(action: @escaping () -> Void) { self.action = action }
        @objc func tapped() { action() }
    }
}

/// I22 (first part): who is signed in, and sign out.
struct AccountView: View {
    let session: SessionStore
    @State private var confirmingSignOut = false

    var body: some View {
        NavigationStack {
            List {
                Section("Signed in as") {
                    Text(session.accountLabel ?? "Your account")
                        .font(AppFonts.body)
                        .foregroundStyle(AppColors.textPrimary)
                }
                Section {
                    Button("Sign out", role: .destructive) { confirmingSignOut = true }
                        .font(AppFonts.body)
                } footer: {
                    Text("Signing out hides bus information on this phone until you sign in again.")
                        .font(AppFonts.caption)
                }
            }
            .navigationTitle("Account")
            .confirmationDialog("Sign out of ITSSB?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { Task { await session.signOut() } }
            }
        }
    }
}

#if DEBUG
@MainActor
private func authPreview(_ scenario: PreviewAuthScenario) -> some View {
    let session = SessionStore(auth: PreviewAuthSession(configured: scenario != .notConfigured))
    scenario.apply(to: session)
    return AppRootView(session: session, source: PreviewLiveRunSource(scenario: .live),
                       initialTab: scenario == .account ? .account : .track)
}

#Preview("Email") { authPreview(.email) }
#Preview("Email invalid") { authPreview(.emailInvalid) }
#Preview("Sending") { authPreview(.sending) }
#Preview("Code") { authPreview(.code) }
#Preview("Code wrong") { authPreview(.codeWrong) }
#Preview("Tracking rejected") { authPreview(.trackingRejected) }
#Preview("Restore failed") { authPreview(.restoreFailed) }
#Preview("Not configured") { authPreview(.notConfigured) }
#Preview("Account") { authPreview(.account) }
#endif
