import ITSSBDesignSystem
import SwiftUI

@main
struct ITSSBApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var environment = AppEnvironment.make()
    @AppStorage(DisplayPreferenceKey.appearance) private var appearance = AppAppearance.system.rawValue

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
                        enrollmentScreen: debugEnrollmentScreen, showsWelcome: environment.showsWelcome)
                .preferredColorScheme(AppAppearance(rawValue: appearance)?.colorScheme)
                .onAppear { AppDelegate.registrar = environment.registrar }
        }
    }
}
