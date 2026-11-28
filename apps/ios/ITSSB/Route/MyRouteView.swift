import ITSSBDesignSystem
import MapKit
import SwiftUI

/// I13 My route and assigned stop: the school's approved path, read-only.
struct MyRouteView: View {
    @State private var model: MyRouteViewModel
    @State private var showsStop = MyRouteView.opensStop

    init(source: any LiveRunSource) {
        _model = State(initialValue: MyRouteViewModel(source: source))
    }

    var body: some View {
        content
            .navigationTitle("My route")
            .navigationBarTitleDisplayMode(.inline)
            .background(AppColors.background)
            .onAppear { model.start() }
            .onDisappear { model.stop() }
    }

    @ViewBuilder private var content: some View {
        switch model.state {
        case .loading:
            ProgressView("Loading your route…")
                .font(AppFonts.body)
                .foregroundStyle(AppColors.textSecondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .unavailable:
            ContentUnavailableView("No approved route", systemImage: "lock.fill",
                                   description: Text("This account isn't on an approved route yet. "
                                                     + "Join a route, and the school will review it."))
        case .sessionExpired:
            ContentUnavailableView("You're signed out", systemImage: "person.crop.circle.badge.exclamationmark",
                                   description: Text("Sign in again to see your route."))
        case .failed:
            ContentUnavailableView {
                Label("Couldn't load your route", systemImage: "wifi.exclamationmark")
            } description: {
                Text("Check your connection and try again.")
            } actions: {
                Button("Try again") { model.start() }
                    .buttonStyle(.borderedProminent)
                    .tint(AppColors.brand)
                    .foregroundStyle(AppColors.onBrand)
            }
        case let .ready(assignment, route):
            ready(assignment, route)
        }
    }

    private func ready(_ assignment: AssignmentSummary, _ route: RouteGeometry) -> some View {
        List {
            Section {
                // No bus marker: this screen is the plan, Track is the live bus.
                BusMapView(route: route, stop: route.assignedStop, bus: nil)
                    .frame(height: AppSpacing.mapPreview)
                    .listRowInsets(EdgeInsets())
                    .accessibilityLabel("Map of \(route.routeLabel) and your stop, \(route.assignedStop.label)")
            }
            Section {
                LabeledContent("Student", value: assignment.studentDisplayName)
                LabeledContent("Route", value: route.routeLabel)
                NavigationLink {
                    StopDetailsView(stop: route.assignedStop, routeLabel: route.routeLabel)
                } label: {
                    LabeledContent("Stop", value: route.assignedStop.label)
                }
                if model.assignments.count > 1 {
                    AssignmentPicker(assignments: model.assignments, selected: model.selectedAssignmentId) {
                        model.select(assignmentId: $0)
                    }
                }
            } footer: {
                Text("The blue line is the route your school approved, not driving directions. "
                     + "The live bus is on Track.")
            }
            Section("Trip check-in") {
                Text(assignment.relationship == .self
                     ? "You can check in on the bus from My Route > Check in."
                     : "Only \(assignment.studentDisplayName) can check in, from their own account.")
                    .foregroundStyle(AppColors.textSecondary)
            }
        }
        .font(AppFonts.body)
        .navigationDestination(isPresented: $showsStop) {
            StopDetailsView(stop: route.assignedStop, routeLabel: route.routeLabel)
        }
    }

    /// `-ITSSBOpen stop` opens I14 directly, for screenshots.
    private static var opensStop: Bool {
        #if DEBUG
        DebugLaunch.opens == "stop"
        #else
        false
        #endif
    }
}

/// I14 Stop details: the stop and a walking-directions handoff to Apple Maps.
/// ITSSB doesn't plan the walk or promise its timing.
struct StopDetailsView: View {
    let stop: AssignedStop
    let routeLabel: String

    var body: some View {
        List {
            Section {
                Map(initialPosition: .camera(MapCamera(centerCoordinate: stop.coordinate.location, distance: 600))) {
                    Marker(stop.label, systemImage: "figure.wave", coordinate: stop.coordinate.location)
                        .tint(AppColors.assignedStop)
                }
                .mapStyle(.standard(pointsOfInterest: .excludingAll))
                .frame(height: AppSpacing.mapPreview)
                .listRowInsets(EdgeInsets())
                .accessibilityLabel("Map of \(stop.label)")
            }
            Section {
                LabeledContent("Stop", value: stop.label)
                LabeledContent("Route", value: routeLabel)
            }
            Section {
                Button {
                    WalkingDirections.open(to: stop)
                } label: {
                    Label("Walking directions in Maps", systemImage: "figure.walk")
                }
            } footer: {
                Text("Opens Apple Maps. Maps plans the walk; ITSSB doesn't check the path or how long it takes.")
            }
        }
        .font(AppFonts.body)
        .navigationTitle(stop.label)
        .navigationBarTitleDisplayMode(.inline)
    }
}

enum WalkingDirections {
    /// Launch options for the Maps handoff: walking, never driving.
    static let launchOptions = [MKLaunchOptionsDirectionsModeKey: MKLaunchOptionsDirectionsModeWalking]

    static func mapItem(for stop: AssignedStop) -> MKMapItem {
        let item = MKMapItem(placemark: MKPlacemark(coordinate: stop.coordinate.location))
        item.name = stop.label
        return item
    }

    @MainActor
    static func open(to stop: AssignedStop) {
        mapItem(for: stop).openInMaps(launchOptions: launchOptions)
    }
}

#Preview { NavigationStack { MyRouteView(source: PreviewLiveRunSource(scenario: .live)) } }
#Preview("Stop") { NavigationStack { StopDetailsView(stop: PreviewFixtures.stop, routeLabel: "Route 17 Morning") } }
