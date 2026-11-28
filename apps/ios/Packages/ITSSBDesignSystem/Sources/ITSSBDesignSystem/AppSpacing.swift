import SwiftUI

/// 4-point spacing scale. Use these instead of numeric padding (lint-enforced).
public enum AppSpacing {
    public static let xxs: CGFloat = 2
    public static let xs: CGFloat = 4
    public static let sm: CGFloat = 8
    public static let md: CGFloat = 12
    public static let lg: CGFloat = 16
    public static let xl: CGFloat = 24
    public static let xxl: CGFloat = 32

    /// Standard inset from the screen edge.
    public static let screen: CGFloat = lg
    /// Width of the route line on the map.
    public static let routeLine: CGFloat = 5
    /// Minimum tappable size (Apple HIG).
    public static let touchTarget: CGFloat = 44
    /// Height of a small, non-interactive map inside a list (My route, stop details).
    public static let mapPreview: CGFloat = 240
}

/// Corner radius scale. Use these instead of numeric radii (lint-enforced).
public enum AppRadius {
    public static let sm: CGFloat = 8
    public static let md: CGFloat = 12
    public static let card: CGFloat = 16
    public static let sheet: CGFloat = 24
}

public extension View {
    /// Standard card: surface background, continuous rounded corners, card padding.
    func cardStyle() -> some View {
        padding(AppSpacing.lg)
            .background(AppColors.surface, in: .rect(cornerRadius: AppRadius.card, style: .continuous))
    }
}
