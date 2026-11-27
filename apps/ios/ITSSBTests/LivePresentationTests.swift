import XCTest
@testable import ITSSB

final class LivePresentationTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_795_609_100)

    private func run(state: RunState = .active, secondsAgo: TimeInterval?, gps: GpsStatus? = .valid,
                     contactSecondsAgo: TimeInterval? = 2) -> TrackedRun {
        PreviewFixtures.run(state: state,
                            position: secondsAgo.map { PreviewFixtures.position(capturedSecondsAgo: $0, now: now) },
                            gpsStatus: gps,
                            contactAt: .some(contactSecondsAgo.map { now.addingTimeInterval(-$0) }))
    }

    private func present(_ run: TrackedRun, at date: Date? = nil) -> LivePresentation {
        LivePresentation.make(run: run, clock: .deviceOnly, now: date ?? now)
    }

    func testFreshAgingStale() {
        XCTAssertEqual(present(run(secondsAgo: 5)), .live(.fresh))
        XCTAssertEqual(present(run(secondsAgo: 45)), .live(.aging))
        XCTAssertEqual(present(run(secondsAgo: 121)), .stale)
    }

    func testBecomesStaleWithoutAnUpdate() {
        let tracked = run(secondsAgo: 5)
        XCTAssertEqual(present(tracked), .live(.fresh))
        XCTAssertEqual(present(tracked, at: now.addingTimeInterval(200)), .stale)
    }

    func testNoPositionNeverShowsAMarker() {
        let presentation = present(run(secondsAgo: nil, gps: nil))
        XCTAssertEqual(presentation, .awaitingFirstPosition)
        XCTAssertFalse(presentation.showsMarker)
    }

    func testGpsUnavailableIsDistinct() {
        XCTAssertEqual(present(run(secondsAgo: nil, gps: .noFix)), .gpsUnavailable(.noFix))
        let withOld = present(run(secondsAgo: 10, gps: .receiverMissing))
        XCTAssertEqual(withOld, .gpsUnavailable(.receiverMissing))
        XCTAssertTrue(withOld.dimsMarker)
    }

    /// D09: gpsStatus is the last heartbeat and the backend never expires it,
    /// so it counts only while the bus's contact is recent.
    func testGpsProblemNeedsRecentContact() {
        XCTAssertEqual(present(run(secondsAgo: nil, gps: .receiverMissing, contactSecondsAgo: 30)),
                       .gpsUnavailable(.receiverMissing))
        XCTAssertEqual(present(run(secondsAgo: nil, gps: .receiverMissing, contactSecondsAgo: 121)),
                       .awaitingFirstPosition)
        XCTAssertEqual(present(run(secondsAgo: nil, gps: .noFix, contactSecondsAgo: nil)), .awaitingFirstPosition)
    }

    func testEndedRunHasNoLiveMarker() {
        for state in [RunState.completed, .cancelled, .scheduled] {
            let presentation = present(run(state: state, secondsAgo: 5))
            XCTAssertEqual(presentation, .notLive(state))
            XCTAssertFalse(presentation.showsMarker)
        }
    }

    func testUnverifiedClockIsNeverFresh() {
        let unverified = ServerClock(serverNow: now, receivedAt: now)
        let tracked = run(secondsAgo: 5)
        XCTAssertEqual(LivePresentation.make(run: tracked, clock: unverified, now: now), .live(.aging))
        XCTAssertEqual(LivePresentation.make(run: run(secondsAgo: 200), clock: unverified, now: now), .stale)
    }

    func testOnlyLiveIsUndimmed() {
        XCTAssertFalse(LivePresentation.live(.fresh).dimsMarker)
        XCTAssertTrue(LivePresentation.stale.dimsMarker)
    }
}
