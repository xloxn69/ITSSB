import ITSSBDesignSystem
import SwiftUI

@main
struct ITSSBApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

/// The four V1 tabs (docs/06). Only Track is implemented so far.
struct RootView: View {
    var body: some View {
        TabView {
            TrackView(source: PreviewLiveRunSource())
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

private struct ComingSoon: View {
    let title: String

    var body: some View {
        ContentUnavailableView(title, systemImage: "hammer", description: Text("Not built yet."))
    }
}
