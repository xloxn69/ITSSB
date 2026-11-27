import ITSSBDesignSystem
import MapKit
import SwiftUI

struct TrackView: View {
    @State private var model: TrackViewModel
    let onSignIn: () -> Void

    init(source: any LiveRunSource, onSignIn: @escaping () -> Void = {}) {
        _model = State(initialValue: TrackViewModel(source: source))
        self.onSignIn = onSignIn
    }

    var body: some View {
        content
            .background(AppColors.background)
            .onAppear { model.start() }
            .onDisappear { model.stop() }
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
                    detail: "Your account isn't linked to an approved route. Your school can approve it.")
        case .sessionExpired:
            ContentUnavailableView {
                Label("Signed out", systemImage: "person.crop.circle.badge.exclamationmark")
            } description: {
                Text("Your session ended. Sign in again to see your bus.")
            } actions: {
                Button("Sign in", action: onSignIn)
            }
        case .failed(let text):
            ContentUnavailableView {
                Label("Something went wrong", systemImage: "exclamationmark.triangle")
            } description: {
                Text(text)
            } actions: {
                Button("Try again") { model.retry() }
            }
        case let .tracking(_, run, clock):
            tracking(run, clock: clock)
        }
    }

    @ViewBuilder
    private func tracking(_ run: TrackedRun, clock: ServerClock) -> some View {
        if let position = run.position {
            let coordinate = CLLocationCoordinate2D(latitude: position.latitude, longitude: position.longitude)
            Map(initialPosition: .camera(MapCamera(centerCoordinate: coordinate, distance: 1500))) {
                Annotation(run.busLabel, coordinate: coordinate) {
                    Image(systemName: "bus.fill")
                        .foregroundStyle(AppColors.onBrand)
                        .padding(AppSpacing.sm)
                        .background(AppColors.brand, in: .circle)
                }
            }
            .safeAreaInset(edge: .bottom) {
                FreshnessCard(position: position, clock: clock)
                    .padding(AppSpacing.screen)
            }
        } else {
            message("Waiting for the bus", systemImage: "location.slash",
                    detail: "The trip has started, but the bus hasn't reported a location yet.")
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
    var clock: ServerClock = .deviceOnly

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let freshness = position.freshness(at: context.date, clock: clock)
            HStack(spacing: AppSpacing.md) {
                Image(systemName: icon(for: freshness))
                    .foregroundStyle(color(for: freshness))
                VStack(alignment: .leading, spacing: AppSpacing.xxs) {
                    Text(label(for: freshness))
                        .font(AppFonts.headline)
                        .foregroundStyle(AppColors.textPrimary)
                    Text(AgeFormatter.updatedText(age: position.age(at: context.date, clock: clock)))
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

#Preview("Live") { TrackView(source: PreviewLiveRunSource(scenario: .live)) }
#Preview("Stale") { TrackView(source: PreviewLiveRunSource(scenario: .stale)) }
