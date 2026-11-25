import SwiftUI

/// Typography tokens. Built on the system font so Dynamic Type works everywhere.
public enum AppFonts {
    public static let largeTitle = Font.largeTitle.weight(.bold)
    public static let title = Font.title2.weight(.semibold)
    public static let headline = Font.headline
    public static let body = Font.body
    public static let callout = Font.callout
    public static let caption = Font.caption
    /// Times and ages ("Updated 12s ago"), with digits that don't jitter as they change.
    public static let numeric = Font.body.monospacedDigit()
}
