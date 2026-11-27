import ITSSBDesignSystem
import SwiftUI

@main
struct ITSSBApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var environment = AppEnvironment.make()

    private var debugEnrollmentScreen: FamilyScreen? {
        #if DEBUG
        environment.enrollmentScreen
        #else
        nil
        #endif
    }

    var body: some Scene {
        WindowGroup {
            AppRootView(session: environment.session, source: environment.source,
                        notifications: environment.notifications, registrar: environment.registrar,
                        initialTab: environment.initialTab, enrollment: environment.enrollment,
                        enrollmentScreen: debugEnrollmentScreen)
                .onAppear { AppDelegate.registrar = environment.registrar }
        }
    }
}
