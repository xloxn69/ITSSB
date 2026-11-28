import SwiftUI

/// Decides when a scene-phase change is a real return to the app (docs/06 §12,
/// docs/13 §7). Only `.background` → `.active` counts: Control Center, the
/// notification shade, and Face ID pass through `.inactive` without leaving the app.
struct ForegroundRefresh {
    private var wasInBackground = false

    mutating func shouldRefresh(on phase: ScenePhase) -> Bool {
        switch phase {
        case .background:
            wasInBackground = true
            return false
        case .active:
            defer { wasInBackground = false }
            return wasInBackground
        default:
            return false
        }
    }
}
