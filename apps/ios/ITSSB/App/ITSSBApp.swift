import ITSSBDesignSystem
import SwiftUI

@main
struct ITSSBApp: App {
    @State private var environment = AppEnvironment.make()

    var body: some Scene {
        WindowGroup {
            AppRootView(session: environment.session, source: environment.source,
                        initialTab: environment.initialTab)
        }
    }
}
