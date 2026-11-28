import ITSSBDesignSystem
import MapKit
import SwiftUI

/// Route line, assigned stop, and bus marker (docs/06 §9).
///
/// The line is the school's approved path, never driving directions. The bus
/// marker appears only for a believable position and is greyed out when it is
/// old. Panning stops following until the person taps **Follow bus**.
struct BusMapView: View {
    let route: RouteGeometry?
    let stop: AssignedStop
    let bus: LivePosition?
    var busLabel = "Bus"
    var dimsBus = false

    /// Transient camera state belongs to the map (docs/06 §6).
    @State private var camera: MapCameraPosition = .automatic
    @State private var following = false
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @AppStorage(DisplayPreferenceKey.reduceMapMotion) private var appReduceMotion = false

    var body: some View {
        Map(position: $camera) {
            if let route, route.path.count > 1 {
                MapPolyline(coordinates: route.path.map(\.location))
                    .stroke(AppColors.route, style: StrokeStyle(lineWidth: AppSpacing.routeLine,
                                                                lineCap: .round, lineJoin: .round))
            }
            Marker(stop.label, systemImage: "figure.wave", coordinate: stop.coordinate.location)
                .tint(AppColors.assignedStop)
            if let bus {
                Annotation(busLabel, coordinate: bus.location, anchor: .center) {
                    BusMarker(dimmed: dimsBus)
                }
            }
        }
        .mapStyle(.standard(pointsOfInterest: .excludingAll))
        .mapControls { MapCompass() }
        .onMapCameraChange(frequency: .onEnd) { _ in
            if camera.positionedByUser { following = false }
        }
        .onChange(of: bus?.eventId) {
            if following, let bus { camera = .camera(MapCamera(centerCoordinate: bus.location, distance: 1500)) }
        }
        .overlay(alignment: .topTrailing) {
            if let bus, !following {
                Button {
                    following = true
                    let motion = MapMotion.followTransaction(systemReduceMotion: systemReduceMotion,
                                                             appReduceMotion: appReduceMotion)
                    withTransaction(motion) {
                        camera = .camera(MapCamera(centerCoordinate: bus.location, distance: 1500))
                    }
                } label: {
                    Label("Follow bus", systemImage: "location.north.line.fill")
                        .font(AppFonts.callout)
                }
                .buttonStyle(.borderedProminent)
                .tint(AppColors.surface)
                .foregroundStyle(AppColors.textPrimary)
                .padding(AppSpacing.screen)
            }
        }
    }
}

private struct BusMarker: View {
    let dimmed: Bool

    var body: some View {
        Image(systemName: "bus.fill")
            .font(AppFonts.headline)
            .foregroundStyle(AppColors.onBrand)
            .padding(AppSpacing.sm)
            .background(dimmed ? AppColors.statusUnknown : AppColors.brand, in: .circle)
            .overlay(Circle().stroke(AppColors.surface, lineWidth: AppSpacing.xxs))
            .accessibilityLabel(dimmed ? "Bus, last known location" : "Bus location")
    }
}

extension Coordinate {
    var location: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: latitude, longitude: longitude) }
}

extension LivePosition {
    var location: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: latitude, longitude: longitude) }
}
