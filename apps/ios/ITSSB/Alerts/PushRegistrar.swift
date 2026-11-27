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
    /// True between a signed-in `refresh` and `deactivate`; late token callbacks are ignored otherwise.
    @ObservationIgnored private var signedIn = false

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

    /// Reads the current permission, asks APNs for a token when allowed, and tells the server.
    /// Called only while signed in.
    func refresh() async {
        signedIn = true
        permission = await authorizing.currentPermission()
        if permission.allowsAlerts { registerForRemoteNotifications() }
        await sync()
    }

    /// Asks the person, from an explicit tap, never on launch.
    /// Before sign-out, while still authenticated: this phone stops receiving
    /// the account's pushes, and later token callbacks are not sent.
    func deactivate() async {
        guard signedIn else { return }
        // Fence first: a token callback or refresh arriving while this awaits
        // must not register again. Mutations from one client run in order, so
        // anything already sent lands before this one.
        signedIn = false
        pushEnabled = false
        do {
            _ = try await source.registerDevice(installationId: installationId, token: nil,
                                                environment: environment, permission: permission)
        } catch {
            registrationFailed = true
        }
    }

    func requestPermission() async {
        permission = await authorizing.requestPermission()
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
        guard signedIn else { return }
        do {
            pushEnabled = try await source.registerDevice(
                installationId: installationId,
                token: permission.allowsAlerts ? token : nil,
                environment: environment, permission: permission)
            registrationFailed = false
        } catch {
            registrationFailed = true
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
