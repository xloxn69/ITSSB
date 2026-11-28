import AVFoundation
import MapKit
import SwiftUI
import XCTest
@testable import ITSSB

/// I01 Welcome, I21 alert currency, I24 reduced motion, camera denial, and
/// foreground detection (docs/06 §5, docs/13 §7).
@MainActor
final class MissingStatesTests: XCTestCase {
    // MARK: I01 Welcome

    func testWelcomeShowsOnlyForAFreshSignedOutPerson() {
        func shows(_ state: SessionState, step: SignInStep = .email, message: String? = nil,
                   working: Bool = false, dismissed: Bool = false) -> Bool {
            WelcomeGate.shows(state: state, step: step, message: message, isWorking: working, dismissed: dismissed)
        }
        XCTAssertTrue(shows(.signedOut(.notSignedIn)))
        XCTAssertFalse(shows(.signedIn), "never over the signed-in tabs")
        XCTAssertFalse(shows(.restoring))
        XCTAssertFalse(shows(.restoreFailed))
        XCTAssertFalse(shows(.signedOut(.signInUnavailable)), "a build without sign-in explains that instead")
        XCTAssertFalse(shows(.signedOut(.notSignedIn), dismissed: true))
        XCTAssertFalse(shows(.signedOut(.notSignedIn), step: .code(email: "sam.example@example.com")),
                       "a sign-in in progress keeps its code screen")
        XCTAssertFalse(shows(.signedOut(.notSignedIn), message: "Enter a valid email address."),
                       "an error must stay readable")
        XCTAssertFalse(shows(.signedOut(.notSignedIn), working: true))
    }

    // MARK: I21 Alert currency

    private let alert = AlertItem(alertId: "al_1", assignmentId: "a_1", runId: "run_1", stopLabel: "Oak & Pine",
                                  createdAt: Date(timeIntervalSince1970: 1_000),
                                  predictedArrivalAt: Date(timeIntervalSince1970: 1_300),
                                  predictionGeneratedAt: Date(timeIntervalSince1970: 1_000))

    private func ready(runId: String = "run_1", assignmentId: String = "a_1", state: RunState = .active,
                       etaMadeAt: TimeInterval?) -> RunSnapshot {
        let eta = etaMadeAt.map {
            RunEta(arrivalAt: Date(timeIntervalSince1970: 1_400), generatedAt: Date(timeIntervalSince1970: $0),
                   validUntil: Date(timeIntervalSince1970: $0 + 60), algorithmVersion: "baseline-v1",
                   sourceEventId: "ev_1")
        }
        let run = TrackedRun(runId: runId, state: state, liveRevision: 1, busLabel: "Bus 12", lastDeviceContactAt: nil,
                             gpsStatus: .valid, position: nil, assignedStop: PreviewFixtures.stop, eta: eta)
        return .ready(assignmentId: assignmentId, routeVersionId: "rv_1", run: run, clock: .deviceOnly,
                      notices: .none)
    }

    private func currency(_ snapshot: RunSnapshot?, failed: Bool = false) -> AlertCurrency {
        AlertCurrency.make(alert: alert, snapshot: snapshot, failed: failed)
    }

    func testAlertIsNeverCurrentWithoutTheLiveRun() {
        XCTAssertEqual(currency(nil), .checking)
        XCTAssertEqual(currency(nil, failed: true), .unknown)
        XCTAssertEqual(currency(.accessUnavailable(.notPermitted)), .unknown)
        XCTAssertEqual(currency(ready(assignmentId: "a_other", etaMadeAt: 1_000)), .unknown)
    }

    func testAlertFromAnEndedTripSaysSo() {
        XCTAssertEqual(currency(.noActiveRun(assignmentId: "a_1", routeVersionId: "rv_1", clock: .deviceOnly,
                                                                notices: .none)), .tripEnded)
        XCTAssertEqual(currency(ready(runId: "run_2", etaMadeAt: 2_000)), .tripEnded, "a later trip isn't this one")
        XCTAssertEqual(currency(ready(state: .completed, etaMadeAt: 1_000)), .tripEnded)
        XCTAssertEqual(currency(ready(state: .cancelled, etaMadeAt: 1_000)), .tripEnded)
    }

    func testNewerEstimateSupersedesTheAlert() {
        XCTAssertEqual(currency(ready(etaMadeAt: 1_030)),
                       .superseded(newerEstimateAt: Date(timeIntervalSince1970: 1_030)))
        XCTAssertEqual(currency(ready(etaMadeAt: 1_000)), .latest)
        XCTAssertEqual(currency(ready(etaMadeAt: nil)), .tripRunningNoEstimate)
    }

    func testAlertDetailFollowsTheTripsRun() async {
        let source = MockLiveRunSource()
        let model = AlertDetailViewModel(alert: alert, tracking: source)
        model.start()
        _ = await eventually { source.runContinuation("a_1") != nil }
        XCTAssertEqual(model.currency, .checking)
        source.runContinuation("a_1")?.yield(ready(etaMadeAt: 1_000))
        let latest = await eventually { model.currency == .latest }
        XCTAssertTrue(latest)
        source.runContinuation("a_1")?.yield(.noActiveRun(assignmentId: "a_1", routeVersionId: "rv_1",
                                                          clock: .deviceOnly, notices: .none))
        let ended = await eventually { model.currency == .tripEnded }
        XCTAssertTrue(ended, "a run that ends while the detail is open is shown as ended")
        model.stop()
    }

    // MARK: Camera permission

    func testCameraPermissionMapsToAnHonestScanState() {
        XCTAssertEqual(CameraAccess.from(.authorized, hasCamera: true), .ready)
        XCTAssertEqual(CameraAccess.from(.notDetermined, hasCamera: true), .needsRequest)
        XCTAssertEqual(CameraAccess.from(.denied, hasCamera: true), .denied)
        XCTAssertEqual(CameraAccess.from(.restricted, hasCamera: true), .denied)
        XCTAssertEqual(CameraAccess.from(.denied, hasCamera: false), .denied, "denial is explained even so")
        XCTAssertEqual(CameraAccess.from(.authorized, hasCamera: false), .unavailable)
        XCTAssertEqual(CameraAccess.from(.notDetermined, hasCamera: false), .unavailable)
    }

    // MARK: I24 Reduced map motion

    func testFollowBusDoesNotAnimateWhenMotionIsReduced() {
        let normal = MapMotion.followTransaction(systemReduceMotion: false, appReduceMotion: false)
        XCTAssertNotNil(normal.animation)
        XCTAssertFalse(normal.disablesAnimations)
        for (system, app) in [(true, false), (false, true), (true, true)] {
            let reduced = MapMotion.followTransaction(systemReduceMotion: system, appReduceMotion: app)
            XCTAssertNil(reduced.animation, "system \(system), app \(app)")
            XCTAssertTrue(reduced.disablesAnimations, "system \(system), app \(app)")
        }
    }

    func testAppearanceChoiceMapsToAColorScheme() {
        XCTAssertNil(AppAppearance.system.colorScheme, "Match iPhone follows the system")
        XCTAssertEqual(AppAppearance.light.colorScheme, .light)
        XCTAssertEqual(AppAppearance.dark.colorScheme, .dark)
    }

    // MARK: Foreground refresh

    func testOnlyAReturnFromTheBackgroundRefreshes() {
        var refresh = ForegroundRefresh()
        XCTAssertFalse(refresh.shouldRefresh(on: .active), "launch is not a return")
        XCTAssertFalse(refresh.shouldRefresh(on: .inactive))
        XCTAssertFalse(refresh.shouldRefresh(on: .active), "Control Center or Face ID: inactive only")
        XCTAssertFalse(refresh.shouldRefresh(on: .background))
        XCTAssertFalse(refresh.shouldRefresh(on: .inactive))
        XCTAssertTrue(refresh.shouldRefresh(on: .active))
        XCTAssertFalse(refresh.shouldRefresh(on: .active), "once per return")
    }

    // MARK: I13 My route

    func testMyRouteNeverDrawsAnotherAssignmentsGeometry() async {
        let source = MockLiveRunSource()
        let model = MyRouteViewModel(source: source)
        model.start()
        _ = await eventually { source.assignmentsContinuation != nil }
        source.assignmentsContinuation?.yield(.ready([PreviewFixtures.assignment]))
        let id = PreviewFixtures.assignment.assignmentId
        _ = await eventually { source.routeContinuation(id) != nil }
        let other = RouteGeometry(assignmentId: "a_other", routeVersionId: "rv_9", routeLabel: "Route 4",
                                  path: PreviewFixtures.route.path, assignedStop: PreviewFixtures.stop)
        source.routeContinuation(id)?.yield(.ready(other))
        let drewOther = await eventually(timeout: 0.3) { model.state != .loading }
        XCTAssertFalse(drewOther, "geometry for another assignment is dropped")
        source.routeContinuation(id)?.yield(.ready(PreviewFixtures.route))
        let ready = await eventually {
            if case let .ready(_, route) = model.state { return route.assignmentId == id }
            return false
        }
        XCTAssertTrue(ready)
        source.routeContinuation(id)?.yield(.accessUnavailable(.unauthenticated))
        let expired = await eventually { model.state == .sessionExpired }
        XCTAssertTrue(expired, "removed access clears the route")
        model.stop()
    }

    /// Review P1: Stop details reads the live route model, so access loss clears the stop.
    func testStopDetailsLoseTheStopWhenAccessEnds() async {
        let source = MockLiveRunSource()
        let model = MyRouteViewModel(source: source)
        model.startIfNeeded()
        _ = await eventually { source.assignmentsContinuation != nil }
        source.assignmentsContinuation?.yield(.ready([PreviewFixtures.assignment]))
        let id = PreviewFixtures.assignment.assignmentId
        _ = await eventually { source.routeContinuation(id) != nil }
        source.routeContinuation(id)?.yield(.ready(PreviewFixtures.route))
        let shown = await eventually { model.currentStop(id: PreviewFixtures.stop.stopId) != nil }
        XCTAssertTrue(shown)
        model.startIfNeeded()
        XCTAssertNotNil(model.currentStop(id: PreviewFixtures.stop.stopId),
                        "returning from details doesn't restart and blank the route")
        XCTAssertEqual(source.assignmentSubscriptionCount, 1, "returning from details keeps the same subscriptions")
        source.routeContinuation(id)?.yield(.accessUnavailable(.notPermitted))
        let cleared = await eventually { model.currentStop(id: PreviewFixtures.stop.stopId) == nil }
        XCTAssertTrue(cleared, "the stop and its directions disappear with access")
    }

    /// The route subscriptions end when the whole My route flow is gone.
    func testReleasingMyRouteEndsItsSubscriptions() async {
        let source = MockLiveRunSource()
        var model: MyRouteViewModel? = MyRouteViewModel(source: source)
        model?.startIfNeeded()
        _ = await eventually { source.assignmentsContinuation != nil }
        source.assignmentsContinuation?.yield(.ready([PreviewFixtures.assignment]))
        let id = PreviewFixtures.assignment.assignmentId
        _ = await eventually { source.routeContinuation(id) != nil }
        model = nil
        let ended = await eventually { source.cancelledRoutes.contains(id) }
        XCTAssertTrue(ended)
    }

    /// Review P2: a restarted detail waits for a new answer, and a lost connection is unconfirmed.
    func testAlertDetailIsNeverStaleAfterRestartOrDisconnect() async {
        let source = MockLiveRunSource()
        let model = AlertDetailViewModel(alert: alert, tracking: source)
        model.start()
        _ = await eventually { source.runContinuation("a_1") != nil && source.connectionSubscriptionCount == 1 }
        source.setConnected(true)
        source.runContinuation("a_1")?.yield(ready(etaMadeAt: 1_000))
        let latest = await eventually { model.currency == .latest }
        XCTAssertTrue(latest)

        source.setConnected(false)
        let unconfirmed = await eventually { model.currency == .unconfirmed }
        XCTAssertTrue(unconfirmed, "a silent subscription can't vouch for the trip")

        model.stop()
        model.start()
        XCTAssertEqual(model.currency, .checking, "a restart doesn't reuse the old answer")
        model.stop()
    }

    func testWalkingDirectionsAskMapsForWalking() {
        XCTAssertEqual(WalkingDirections.launchOptions[MKLaunchOptionsDirectionsModeKey],
                       MKLaunchOptionsDirectionsModeWalking)
        XCTAssertEqual(WalkingDirections.mapItem(for: PreviewFixtures.stop).name, "Oak & Pine")
    }
}
