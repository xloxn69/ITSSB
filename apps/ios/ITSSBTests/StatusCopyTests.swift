import XCTest
@testable import ITSSB

/// The card's words must never call old or missing data "live".
final class StatusCopyTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_795_609_100)
    private let utc = TimeZone(identifier: "UTC")!

    private func copy(secondsAgo: TimeInterval?, state: RunState = .active, gps: GpsStatus? = .valid) -> StatusCopy {
        let run = PreviewFixtures.run(
            state: state, position: secondsAgo.map { PreviewFixtures.position(capturedSecondsAgo: $0, now: now) },
            gpsStatus: gps)
        let presentation = LivePresentation.make(run: run, clock: .deviceOnly, now: now)
        return StatusCopy.make(presentation, run: run, clock: .deviceOnly, now: now, timeZone: utc)
    }

    func testFresh() {
        let fresh = copy(secondsAgo: 4)
        XCTAssertEqual(fresh.tone, .fresh)
        XCTAssertEqual(fresh.title, "Bus 12 is on the way")
        XCTAssertEqual(fresh.age, "Updated just now")
    }

    func testAgingSaysItIsWaiting() {
        let aging = copy(secondsAgo: 50)
        XCTAssertEqual(aging.tone, .aging)
        XCTAssertEqual(aging.title, "Waiting for an update")
        XCTAssertEqual(aging.age, "Updated 50s ago")
    }

    func testStaleShowsCaptureTimeAndAge() {
        let stale = copy(secondsAgo: 300)
        XCTAssertEqual(stale.tone, .stale)
        XCTAssertEqual(stale.title, "Last known location")
        XCTAssertTrue(stale.detail.contains("Reported at"), stale.detail)
        XCTAssertTrue(stale.detail.contains(StatusCopy.capturedTime(now.addingTimeInterval(-300), timeZone: utc)))
        XCTAssertEqual(stale.age, "Updated 5 min ago")
        XCTAssertFalse(stale.title.localizedCaseInsensitiveContains("on the way"))
    }

    func testNoPositionHasNoAge() {
        let waiting = copy(secondsAgo: nil, gps: nil)
        XCTAssertNil(waiting.age)
        XCTAssertEqual(waiting.tone, .unknown)
    }

    func testGpsUnavailableExplainsTheBusSide() {
        XCTAssertTrue(copy(secondsAgo: 10, gps: .noFix).detail.contains("can't get a signal"))
        XCTAssertTrue(copy(secondsAgo: 10, gps: .receiverMissing).detail.contains("receiver isn't working"))
    }

    func testEndedTripHasNoAge() {
        let done = copy(secondsAgo: 4, state: .completed)
        XCTAssertEqual(done.title, "Trip completed")
        XCTAssertNil(done.age)
        XCTAssertEqual(copy(secondsAgo: 4, state: .cancelled).title, "Trip cancelled")
    }
}
