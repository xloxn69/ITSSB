import ITSSBDesignSystem
import MapKit
import SwiftUI

struct TrackView: View {
    @State private var model: TrackViewModel

    init(source: any LiveRunSource) {
        _model = State(initialValue: TrackViewModel(source: source))
    }

    var body: some View {
        content
            .background(AppColors.background)
            .task { await model.refresh() }
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .loading:
            ProgressView("Finding your bus…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .noActiveRun:
            message("No trip right now", systemImage: "bus", detail: "Your bus isn't running a route at the moment.")
        case .accessUnavailable:
            message("Tracking not available", systemImage: "lock",
                    detail: "Your account isn't linked to a route yet. Your school can approve it.")
        case .failed(let text):
            message("Something went wrong", systemImage: "exclamationmark.triangle", detail: text)
        case .tracking(let position):
            tracking(position)
        }
    }

    private func tracking(_ position: LivePosition) -> some View {
        let coordinate = CLLocationCoordinate2D(latitude: position.latitude, longitude: position.longitude)
        return Map(initialPosition: .camera(MapCamera(centerCoordinate: coordinate, distance: 1500))) {
            Annotation("Bus", coordinate: coordinate) {
                Image(systemName: "bus.fill")
                    .foregroundStyle(AppColors.onBrand)
                    .padding(AppSpacing.sm)
                    .background(AppColors.brand, in: .circle)
            }
        }
        .safeAreaInset(edge: .bottom) {
            FreshnessCard(position: position)
                .padding(AppSpacing.screen)
        }
    }

    private func message(_ title: String, systemImage: String, detail: String) -> some View {
        ContentUnavailableView(title, systemImage: systemImage, description: Text(detail))
    }
}

/// Shows how old the position is. Re-renders every second on its own, so the
/// age keeps advancing even when no new update arrives.
struct FreshnessCard: View {
    let position: LivePosition

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let freshness = position.freshness(at: context.date)
            HStack(spacing: AppSpacing.md) {
                Image(systemName: icon(for: freshness))
                    .foregroundStyle(color(for: freshness))
                VStack(alignment: .leading, spacing: AppSpacing.xxs) {
                    Text(label(for: freshness))
                        .font(AppFonts.headline)
                        .foregroundStyle(AppColors.textPrimary)
                    Text(AgeFormatter.updatedText(age: position.age(at: context.date)))
                        .font(AppFonts.numeric)
                        .foregroundStyle(AppColors.textSecondary)
                }
                Spacer()
            }
            .cardStyle()
            .accessibilityElement(children: .combine)
        }
    }

    private func label(for freshness: Freshness) -> String {
        switch freshness {
        case .fresh: "Bus location"
        case .aging: "Waiting for an update"
        case .stale: "Last known location"
        }
    }

    private func icon(for freshness: Freshness) -> String {
        switch freshness {
        case .fresh: "location.fill"
        case .aging: "clock"
        case .stale: "exclamationmark.triangle.fill"
        }
    }

    private func color(for freshness: Freshness) -> Color {
        switch freshness {
        case .fresh: AppColors.statusFresh
        case .aging: AppColors.statusAging
        case .stale: AppColors.statusStale
        }
    }
}

#Preview("Fresh") { TrackView(source: PreviewLiveRunSource()) }
#Preview("Stale") { TrackView(source: PreviewLiveRunSource(capturedSecondsAgo: 300)) }
