@preconcurrency import ConvexMobile
import Foundation
import Observation

/// Sign-in as docs/06 §4 defines it: email plus a one-time code, or Sign in
/// with Apple, through the identity provider (Clerk, docs/17 §8).
///
/// Signing in proves control of an identity; it grants nothing. The backend
/// decides access, so a signed-in person may still see "Tracking not
/// available" until staff link their account. The app never holds a backend
/// admin key or the provider's secret key.
@MainActor
protocol AuthSession: AnyObject {
    /// False when this build has no identity provider configured.
    var isConfigured: Bool { get }
    /// A label for the signed-in account (an email address), when known.
    var accountLabel: String? { get }
    /// Restores a cached session without UI. Returns true when signed in;
    /// throws when the sign-in service can't be reached.
    func restore() async throws -> Bool
    /// Sends a one-time code to `email` (creating the identity on first use).
    func sendEmailCode(to email: String) async throws
    func resendEmailCode() async throws
    /// Verifies the code; on success the tracking backend is authenticated too.
    func verifyEmailCode(_ code: String) async throws
    func signInWithApple() async throws
    func signOut() async
}

/// Sign-in failures, each with its own honest message.
enum AuthError: Error, Equatable {
    case notConfigured
    case invalidEmail
    case invalidCode
    case codeExpired
    case tooManyAttempts
    case network
    /// Signed in with the provider, but the tracking service couldn't be reached to confirm it.
    case trackingUnreachable
    /// The provider signed the person in, but the tracking backend refused the session
    /// (for example the `convex` JWT template or the issuer isn't set up yet).
    case trackingRejected
    /// The provider needs more than this app collects (for example a second factor).
    case needsMoreInfo
    case cancelled
    case failed

    /// Inline message, or nil when nothing should be shown (the person cancelled).
    var message: String? {
        switch self {
        case .notConfigured: "Sign-in isn't set up in this build."
        case .invalidEmail: "Enter a valid email address."
        case .invalidCode: "That code isn't right. Check the email and try again."
        case .codeExpired: "That code has expired. Send a new one."
        case .tooManyAttempts: "Too many tries. Wait a minute, then try again."
        case .network: "Couldn't reach the sign-in service. Check your connection and try again."
        case .trackingUnreachable: "You're signed in, but the tracking service couldn't be reached. Try again."
        case .trackingRejected:
            "You signed in, but the tracking service didn't accept the session, so you've been signed out. "
                + "Your school's setup may not be finished."
        case .needsMoreInfo: "This account needs more setup before it can sign in here. Contact your school."
        case .cancelled: nil
        case .failed: "Sign-in didn't finish. Try again."
        }
    }
}

enum SessionState: Equatable {
    /// Restoring a cached session. Show a real loading state (docs/06 §4).
    case restoring
    /// The sign-in service couldn't be reached while restoring; offer a retry.
    case restoreFailed
    case signedIn
    case signedOut(SignedOutReason)
}

enum SignedOutReason: Equatable {
    case notSignedIn
    /// No identity provider is configured in this build.
    case signInUnavailable
}

/// Where the sign-in form is (docs/06 I02, I03).
enum SignInStep: Equatable {
    case email
    case code(email: String)
}

/// Owns identity state and the sign-in form for the process (docs/06 §6).
/// Tracking views appear only while `.signedIn`, so signing out tears down
/// their subscriptions and drops protected data with them.
@MainActor
@Observable
final class SessionStore {
    private(set) var state: SessionState = .restoring
    private(set) var step: SignInStep = .email
    private(set) var isWorking = false
    /// Inline error for the current step.
    private(set) var message: String?
    /// When "Send a new code" becomes available again (docs/06 I03: resend when allowed).
    private(set) var resendAvailableAt: Date?

    static let resendCooldown: TimeInterval = 30

    private let auth: any AuthSession
    private let now: () -> Date
    /// Runs after protected screens are hidden but before the session ends, while
    /// the client is still authenticated (e.g. stop this phone's pushes). Bounded
    /// by `signOutCleanupLimit`, so an offline phone still signs out promptly.
    @ObservationIgnored var beforeSignOut: (@MainActor () async -> Void)?
    @ObservationIgnored var signOutCleanupLimit: Duration = .seconds(3)
    /// Drops in-memory state bound to the signed-out account (e.g. a pending
    /// notification tap). Runs when protected screens hide and again before the
    /// form unlocks, so nothing left from this account reaches the next one.
    @ObservationIgnored var clearAccountState: (@MainActor () -> Void)?

    init(auth: any AuthSession, now: @escaping () -> Date = { Date() }) {
        self.auth = auth
        self.now = now
    }

    var accountLabel: String? { auth.accountLabel }

    /// Waits for `work` or `limit`, whichever comes first; `work` may finish later.
    private static func run(_ work: @escaping @MainActor () async -> Void, atMost limit: Duration) async {
        let gate = FirstOnly()
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            Task { @MainActor in
                await work()
                if gate.claim() { continuation.resume() }
            }
            Task { @MainActor in
                try? await Task.sleep(for: limit)
                if gate.claim() { continuation.resume() }
            }
        }
    }

    func restore() async {
        guard auth.isConfigured else {
            state = .signedOut(.signInUnavailable)
            return
        }
        state = .restoring
        do {
            state = try await auth.restore() ? .signedIn : .signedOut(.notSignedIn)
        } catch AuthError.trackingRejected {
            await auth.signOut()
            show(.trackingRejected)
            state = .signedOut(.notSignedIn)
        } catch {
            state = .restoreFailed
        }
    }

    func submitEmail(_ raw: String) async {
        let email = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.isPlausibleEmail(email) else { return show(.invalidEmail) }
        await perform {
            try await auth.sendEmailCode(to: email)
            step = .code(email: email)
            resendAvailableAt = now().addingTimeInterval(Self.resendCooldown)
        }
    }

    func submitCode(_ raw: String) async {
        let code = raw.filter { !$0.isWhitespace }
        guard !code.isEmpty, code.allSatisfy(\.isNumber) else { return show(.invalidCode) }
        await perform {
            try await auth.verifyEmailCode(code)
            finishSignIn()
        }
    }

    func resendCode() async {
        guard canResend(at: now()) else { return }
        await perform {
            try await auth.resendEmailCode()
            resendAvailableAt = now().addingTimeInterval(Self.resendCooldown)
        }
    }

    func canResend(at date: Date) -> Bool {
        guard case .code = step else { return false }
        return resendAvailableAt.map { date >= $0 } ?? true
    }

    /// Back to the email step (docs/06 I03: change email).
    func changeEmail() {
        step = .email
        message = nil
        resendAvailableAt = nil
    }

    func signInWithApple() async {
        await perform {
            try await auth.signInWithApple()
            finishSignIn()
        }
    }

    /// Hides protected screens at once, then cleans up. The form stays locked until cleanup
    /// finishes, so a new sign-in can't overlap a sign-out still in flight.
    func signOut() async {
        step = .email
        message = nil
        resendAvailableAt = nil
        state = auth.isConfigured ? .signedOut(.notSignedIn) : .signedOut(.signInUnavailable)
        clearAccountState?()
        isWorking = true
        if let cleanup = beforeSignOut { await Self.run(cleanup, atMost: signOutCleanupLimit) }
        await auth.signOut()
        // Anything that arrived for this account while signing out; the next sign-in can't start yet.
        clearAccountState?()
        isWorking = false
    }

    // MARK: Private

    private func finishSignIn() {
        step = .email
        message = nil
        resendAvailableAt = nil
        state = .signedIn
    }

    private func perform(_ body: () async throws -> Void) async {
        guard !isWorking else { return }
        isWorking = true
        message = nil
        defer { isWorking = false }
        do {
            try await body()
        } catch AuthError.trackingUnreachable {
            // The provider session is kept; retrying restores it once the connection is back.
            changeEmail()
            state = .restoreFailed
        } catch let error as AuthError {
            if error == .trackingRejected { changeEmail() }
            show(error)
        } catch {
            show(.failed)
        }
    }

    private func show(_ error: AuthError) {
        message = error.message
    }

    static func isPlausibleEmail(_ email: String) -> Bool {
        email.range(of: #"^[^@\s]+@[^@\s]+\.[^@\s]+$"#, options: .regularExpression) != nil
    }

    #if DEBUG
    /// Puts the form in a given state, for previews and scenario screenshots only.
    func preset(state: SessionState, step: SignInStep = .email, message: AuthError? = nil,
                isWorking: Bool = false, resendIn: TimeInterval? = nil) {
        self.state = state
        self.step = step
        self.message = message?.message
        self.isWorking = isWorking
        self.resendAvailableAt = resendIn.map { now().addingTimeInterval($0) }
    }
    #endif
}

/// What the tracking backend made of a sign-in.
enum ConvexLoginOutcome: Equatable {
    /// The backend recognizes the identity (it may still have no access: that is decided per query).
    case accepted
    /// The backend answered as if no one were signed in (for example a JWT template or issuer mismatch).
    case rejected
    /// No answer: offline, or the token couldn't be fetched.
    case unreachable
}

/// Controls the Convex client's authentication. `ConvexClientAuth` in the
/// app; a fake in tests.
@MainActor
protocol ConvexAuthControlling: AnyObject {
    /// Installs a fresh provider token, then confirms the backend recognizes the identity.
    func login() async -> ConvexLoginOutcome
    func logout() async
}

/// `ConvexAuthControlling` over the process-wide `ConvexClientWithAuth`.
///
/// ConvexMobile's `login()` succeeding only means a token was installed, so
/// the identity is confirmed with one `tracking:myAssignments` answer (since
/// #28, `unauthenticated` there means the backend saw no identity). When the
/// server rejects the token outright, ConvexMobile 0.8.2 doesn't answer the
/// query; it reconnects and forces a token refresh. So no answer plus a forced
/// refresh means rejected, and no answer alone means unreachable.
@MainActor
final class ConvexClientAuth: ConvexAuthControlling {
    private let client: ConvexClientWithAuth<String>
    private let querying: any ConvexQuerying
    private let forcedRefreshes: @MainActor () -> Int
    static let confirmTimeout: Duration = .seconds(10)

    init(client: ConvexClientWithAuth<String>, querying: any ConvexQuerying,
         forcedRefreshes: @escaping @MainActor () -> Int) {
        self.client = client
        self.querying = querying
        self.forcedRefreshes = forcedRefreshes
    }

    func login() async -> ConvexLoginOutcome {
        let before = forcedRefreshes()
        if case let .failure(error) = await client.login() {
            return Self.outcome(forLoginError: error)
        }
        let answer = await Self.firstAnswer(querying: querying, timeout: Self.confirmTimeout)
        return Self.outcome(for: answer, forcedRefreshesSinceLogin: forcedRefreshes() - before)
    }

    func logout() async {
        await client.logout()
    }

    /// A token that couldn't be fetched offline is unreachable, not a rejection.
    nonisolated static func outcome(forLoginError error: Error) -> ConvexLoginOutcome {
        if let auth = error as? AuthError, auth == .network { return .unreachable }
        if error is URLError { return .unreachable }
        return .rejected
    }

    nonisolated static func outcome(for snapshot: AssignmentsSnapshot?,
                                    forcedRefreshesSinceLogin: Int = 0) -> ConvexLoginOutcome {
        switch snapshot {
        case nil: forcedRefreshesSinceLogin > 0 ? .rejected : .unreachable
        case .accessUnavailable(.unauthenticated): .rejected
        case .ready, .accessUnavailable(.notPermitted): .accepted
        }
    }

    /// The first `tracking:myAssignments` answer, or nil after `timeout`.
    nonisolated static func firstAnswer(querying: any ConvexQuerying, timeout: Duration) async -> AssignmentsSnapshot? {
        let stream = querying.subscribe("tracking:myAssignments", args: [:], as: MyAssignmentsDTO.self) {
            try DomainMapping.assignments(from: $0)
        }
        let first = await withTaskGroup(of: AssignmentsSnapshot?.self) { group -> AssignmentsSnapshot? in
            group.addTask { try? await stream.first(where: { _ in true }) }
            group.addTask {
                try? await Task.sleep(for: timeout)
                return nil
            }
            let result = await group.next()
            group.cancelAll()
            return result.flatMap { $0 }
        }
        return first
    }
}

/// Lets exactly one of several callers through.
@MainActor
private final class FirstOnly {
    private var claimed = false
    func claim() -> Bool {
        defer { claimed = true }
        return !claimed
    }
}
