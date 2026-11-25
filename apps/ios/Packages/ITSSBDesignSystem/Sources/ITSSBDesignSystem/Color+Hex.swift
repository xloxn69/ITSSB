import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

public extension Color {
    /// Creates a color from a 6-digit (RGB) or 8-digit (ARGB) hex string. Returns nil if invalid.
    init?(hex: String) {
        let cleaned = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        guard cleaned.count == 6 || cleaned.count == 8,
              let value = UInt64(cleaned, radix: 16) else { return nil }
        let alpha, red, green, blue: UInt64
        if cleaned.count == 6 {
            (alpha, red, green, blue) = (255, value >> 16, value >> 8 & 0xFF, value & 0xFF)
        } else {
            (alpha, red, green, blue) = (value >> 24, value >> 16 & 0xFF, value >> 8 & 0xFF, value & 0xFF)
        }
        self.init(
            .sRGB,
            red: Double(red) / 255,
            green: Double(green) / 255,
            blue: Double(blue) / 255,
            opacity: Double(alpha) / 255
        )
    }

    /// A color that adapts to light and dark mode. Falls back to `light` where traits are unavailable.
    init(light: String, dark: String) {
        #if canImport(UIKit)
        let lightColor = UIColor(Color(hex: light) ?? .clear)
        let darkColor = UIColor(Color(hex: dark) ?? .clear)
        self.init(UIColor { $0.userInterfaceStyle == .dark ? darkColor : lightColor })
        #else
        self = Color(hex: light) ?? .clear
        #endif
    }
}
