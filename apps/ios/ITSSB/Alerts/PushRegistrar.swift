import Foundation
import Observation
import Security

/// Where this installation's ID lives. The app uses the Keychain, which
/// survives a reinstall, so a reinstalled app keeps its push-token ownership.
protocol InstallationIdStoring: Sendable {
    func load() -> String?
    func save(_ id: String)
}

struct KeychainInstallationIdStore: InstallationIdStoring {
    private let account = "itssb.installationId"

    func load() -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrAccount as String: account,
                                    kSecReturnData as String: true]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func save(_ id: String) {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                   kSecAttrAccount as String: account]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = Data(id.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
}

/// The operating system's notification permission, behind a seam for tests.
protocol PushAuthorizing: Sendable {
    func currentPermission() async -> PushPermission
    /// Shows the system prompt (once); returns the resulting permission.
    func requestPermission() async -> PushPermission
}

/// Keeps the backend's record of this installation current (docs/08 §9.1):
/// the APNs token, the app environment, and the OS permission, which is
/// recorded separately from the person's alert preferences.
///
/// Closed-app delivery also needs the owner's APNs key on the backend and a
/// signed build with the Push Notifications capability; neither exists yet.
@MainActor @Observable
final class PushRegistrar {
    private(set) var permission: PushPermission = .notDetermined
    /// What the server answered last: whether it can push to this installation.
    private(set) var pushEnabled = false
    private(set) var registrationFailed = false

    @ObservationIgnored let installationId: String
    @ObservationIgnored private var token: String?
    @ObservationIgnored private let source: any NotificationSource
    @ObservationIgnored private let authorizing: any PushAuthorizing
    @ObservationIgnored private let environment: PushEnvironment
    @ObservationIgnored private let registerForRemoteNotifications: @MainActor () -> Void
    /// True between `activate` (on sign-in) and `deactivate` (before sign-out).
    /// Nothing is sent to the server outside that window.
    @ObservationIgnored private var active = false
    /// Bumped by `deactivate`; work that started before it is dropped when it resumes.
    @ObservationIgnored private var epoch = 0
    /// Server calls run one at a time in order, so sign-out's disable always lands
    /// after any registration that was already on its way.
    @ObservationIgnored private var queue: Task<Void, Never>?

    private func enqueue(_ operation: @escaping @MainActor () async -> Void) async {
        let previous = queue
        let task = Task { @MainActor in
            await previous?.value
            await operation()
        }
        queue = task
        await task.value
    }

    init(source: any NotificationSource, authorizing: any PushAuthorizing,
         ids: any InstallationIdStoring = KeychainInstallationIdStore(),
         environment: PushEnvironment, registerForRemoteNotifications: @escaping @MainActor () -> Void) {
        self.source = source
        self.authorizing = authorizing
        self.environment = environment
        self.registerForRemoteNotifications = registerForRemoteNotifications
        if let saved = ids.load() {
            installationId = saved
        } else {
            installationId = UUID().uuidString.lowercased()
            ids.save(installationId)
        }
    }

    /// On sign-in only: opens the registration window, then refreshes.
    func activate() async {
        active = true
        await refresh()
    }

    /// Reads the current permission, asks APNs for a token when allowed, and tells
    /// the server. Does nothing unless signed in (`activate`), and drops its result
    /// if sign-out began while it waited.
    func refresh() async {
        guard active else { return }
        let started = epoch
        let current = await authorizing.currentPermission()
        guard active, started == epoch else { return }
        permission = current
        if permission.allowsAlerts { registerForRemoteNotifications() }
        await sync()
    }

    /// Before sign-out, while still authenticated: this phone stops receiving
    /// the account's pushes, and later token callbacks are not sent.
    func deactivate() async {
        guard active else { return }
        // Fence first: a token callback or refresh arriving while this awaits
        // must not register again. The disable joins the call queue, so a
        // registration already on its way finishes before it.
        active = false
        epoch += 1
        pushEnabled = false
        await enqueue { [self] in
            do {
                _ = try await source.registerDevice(installationId: installationId, token: nil,
                                                    environment: environment, permission: permission)
            } catch {
                registrationFailed = true
            }
        }
    }

    /// Asks the person, from an explicit tap, never on launch.
    func requestPermission() async {
        guard active else { return }
        let started = epoch
        let current = await authorizing.requestPermission()
        guard active, started == epoch else { return }
        permission = current
        if permission.allowsAlerts { registerForRemoteNotifications() }
        await sync()
    }

    func didRegister(deviceToken: Data) async {
        token = NotificationMapping.hex(deviceToken)
        await sync()
    }

    func didFailToRegister() async {
        token = nil
        await sync()
    }

    private func sync() async {
        guard active else { return }
        let started = epoch
        await enqueue { [self] in
            // A sign-out queued ahead of this turn already disabled the phone.
            guard started == epoch else { return }
            do {
                let enabled = try await source.registerDevice(
                    installationId: installationId,
                    token: permission.allowsAlerts ? token : nil,
                    environment: environment, permission: permission)
                if started == epoch { pushEnabled = enabled }
                registrationFailed = false
            } catch {
                registrationFailed = true
            }
        }
    }
}

/// Carries a tapped notification's assignment to the Track tab. The app then
/// fetches current state; the payload is never shown as current (docs/10 §9).
@MainActor @Observable
final class NotificationRouter {
    static let shared = NotificationRouter()
    var requestedAssignmentId: String?

    /// Reads only the opaque assignment ID from the payload.
    nonisolated static func assignmentId(from userInfo: [AnyHashable: Any]) -> String? {
        (userInfo["itssb"] as? [String: Any])?["assignmentId"] as? String
    }
}
