import ITSSBDesignSystem
import SwiftUI

/// A small "Development build" / "Staging build" label (docs/14 §2). Shows
/// nothing in a production build.
struct EnvironmentBadge: View {
    var info: BuildInfo = .fromBundle()

    var body: some View {
        if let label = info.environmentLabel {
            Text(label)
                .font(AppFonts.caption)
                .foregroundStyle(AppColors.textPrimary)
                .padding(.horizontal, AppSpacing.sm)
                .padding(.vertical, AppSpacing.xs)
                .overlay(
                    RoundedRectangle(cornerRadius: AppRadius.sm, style: .continuous)
                        .stroke(AppColors.statusAging, lineWidth: AppSpacing.xxs / 2)
                )
                .accessibilityLabel("\(label), not the production app")
        }
    }
}
