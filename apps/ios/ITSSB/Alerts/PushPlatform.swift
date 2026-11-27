import SwiftUI
import UIKit
@preconcurrency import UserNotifications

/// `UNUserNotificationCenter` behind `PushAuthorizing`.
struct SystemPushAuthorizing: PushAuthorizing {
    func currentPermission() async -> PushPermission {
        switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .authorized, .ephemeral: .authorized
        case .provisional: .provisional
        case .denied: .denied
        case .notDetermined: .notDetermined
        @unknown default: .denied
        }
    }

    func requestPermission() async -> PushPermission {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        return await currentPermission()
    }
}

/// Receives the APNs token and notification taps for the SwiftUI app.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    /// Set by `ITSSBApp` once the environment exists.
    @MainActor static var registrar: PushRegistrar?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
        Task { @MainActor in await Self.registrar?.didRegister(deviceToken: token) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in await Self.registrar?.didFailToRegister() }
    }

    /// Foreground: show it; the Track tab already has the live estimate.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification)
        async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    /// A tap opens that assignment's live state; the old payload is never shown as current.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse) async {
        let assignmentId = NotificationRouter.assignmentId(from: response.notification.request.content.userInfo)
        await MainActor.run { NotificationRouter.shared.requestedAssignmentId = assignmentId }
    }
}
