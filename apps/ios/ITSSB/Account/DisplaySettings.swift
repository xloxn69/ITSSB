import ITSSBDesignSystem
import SwiftUI

/// The person's appearance choice (docs/06 I24). Stored on this phone only.
enum AppAppearance: String, CaseIterable, Identifiable {
    case system, light, dark

    var id: String { rawValue }

    /// Nil follows the iPhone's own setting.
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    var label: String {
        switch self {
        case .system: "Match iPhone"
        case .light: "Light"
        case .dark: "Dark"
        }
    }
}

/// `UserDefaults` keys for display preferences. Nothing here is account data.
enum DisplayPreferenceKey {
    static let appearance = "display.appearance"
    static let reduceMapMotion = "display.reduceMapMotion"
}

/// How the map camera moves (docs/06 §14: reduced map motion when requested).
enum MapMotion {
    /// The transaction for a Follow bus camera move. With iOS Reduce Motion or
    /// the in-app choice on, the camera jumps instead of flying.
    static func followTransaction(systemReduceMotion: Bool, appReduceMotion: Bool) -> Transaction {
        guard systemReduceMotion || appReduceMotion else { return Transaction(animation: .default) }
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        return transaction
    }
}

/// I24: appearance, reduced map motion, and how text size and contrast follow iOS.
struct DisplaySettingsView: View {
    @AppStorage(DisplayPreferenceKey.appearance) private var appearance = AppAppearance.system.rawValue
    @AppStorage(DisplayPreferenceKey.reduceMapMotion) private var reduceMapMotion = false
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        List {
            Section("Appearance") {
                Picker("Appearance", selection: $appearance) {
                    ForEach(AppAppearance.allCases) { Text($0.label).tag($0.rawValue) }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            }
            Section {
                Toggle("Reduce map motion", isOn: $reduceMapMotion)
                if systemReduceMotion {
                    Text("Reduce Motion is on in iOS Settings, so the map already moves without animation.")
                        .font(AppFonts.caption)
                        .foregroundStyle(AppColors.textSecondary)
                }
            } header: {
                Text("Map")
            } footer: {
                Text("When on, Follow bus moves the map straight to the bus instead of gliding there.")
            }
            Section {
                VStack(alignment: .leading, spacing: AppSpacing.xs) {
                    Text("Bus 12 is reporting its location")
                        .font(AppFonts.headline)
                        .foregroundStyle(AppColors.textPrimary)
                    Text("Updated 4s ago")
                        .font(AppFonts.numeric)
                        .foregroundStyle(AppColors.statusFresh)
                    Text("This sample uses your current text size.")
                        .font(AppFonts.callout)
                        .foregroundStyle(AppColors.textSecondary)
                }
                .accessibilityElement(children: .combine)
                LabeledContent("Text size", value: dynamicTypeSize.isAccessibilitySize ? "Larger accessibility size"
                                   : dynamicTypeSize > .large ? "Larger than default" : "Default or smaller")
                LabeledContent("Increase Contrast", value: contrast == .increased ? "On" : "Off")
            } header: {
                Text("Text and contrast")
            } footer: {
                Text("ITSSB follows the text size and contrast you choose in iOS Settings > Accessibility.")
            }
        }
        .font(AppFonts.body)
        .navigationTitle("Display")
    }
}

#Preview { NavigationStack { DisplaySettingsView() } }
