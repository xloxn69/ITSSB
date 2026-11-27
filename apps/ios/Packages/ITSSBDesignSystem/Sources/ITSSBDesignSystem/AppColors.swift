import SwiftUI

/// Semantic color tokens. Views use these, never literal colors.
///
/// Status colors carry meaning (fresh / aging / stale), so they are always
/// paired with text or an icon; color alone never communicates state.
public enum AppColors {
    // MARK: Surfaces

    public static let background = Color(light: "F7F7F5", dark: "101113")
    public static let surface = Color(light: "FFFFFF", dark: "1A1C1F")
    public static let surfaceMuted = Color(light: "EEEEEA", dark: "24272B")
    public static let border = Color(light: "DEDED8", dark: "33373C")

    // MARK: Text

    public static let textPrimary = Color(light: "16181B", dark: "F2F3F5")
    public static let textSecondary = Color(light: "5C6168", dark: "A3A9B1")

    // MARK: Brand

    /// School-bus yellow. Use for the bus marker and primary actions.
    public static let brand = Color(light: "F2B300", dark: "FFC51A")
    /// Text/icons placed on `brand`.
    public static let onBrand = Color(light: "16181B", dark: "16181B")

    // MARK: Map

    /// The school's approved route line. Distinct from the brand-yellow bus marker.
    public static let route = Color(light: "2F6FDE", dark: "6FA0FF")
    /// The family's own assigned stop.
    public static let assignedStop = Color(light: "16181B", dark: "F2F3F5")

    // MARK: Data freshness

    public static let statusFresh = Color(light: "1F8A4C", dark: "3DBE72")
    public static let statusAging = Color(light: "B26A00", dark: "F0A23B")
    public static let statusStale = Color(light: "B3261E", dark: "F2766B")
    public static let statusUnknown = Color(light: "6B7078", dark: "8E949C")
}
