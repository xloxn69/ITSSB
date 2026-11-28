import XCTest
@testable import ITSSB

/// D14 and docs/06 I19/I27: today's ended trip and calendar notice from `tracking:myRun`.
final class TripNoticesTests: XCTestCase {
    private let received = Date(timeIntervalSince1970: 1_795_609_085.6)
    /// End of 2026-11-25 in New York, the fixtures' service day.
    private let endOfDay = Date(timeIntervalSince1970: 1_795_669_200)
    private let newYork = TimeZone(identifier: "America/New_York")!

    private func notices(_ name: String) throws -> TripNotices {
        try notices(data: ContractFixture.data(name))
    }

    private func notices(data: Data) throws -> TripNotices {
        switch try DomainMapping.snapshot(from: JSONDecoder().decode(MyRunDTO.self, from: data), receivedAt: received) {
        case let .noActiveRun(_, _, _, notices), let .ready(_, _, _, _, notices): return notices
        case .accessUnavailable: throw MappingError.invalidField("unexpected access_unavailable")
        }
    }

    private func removing(_ keys: [String], from name: String) throws -> Data {
        var root = try XCTUnwrap(JSONSerialization.jsonObject(with: ContractFixture.data(name)) as? [String: Any])
        for key in keys { root.removeValue(forKey: key) }
        return try JSONSerialization.data(withJSONObject: root)
    }

    // MARK: Decoding

    func testCancelledFixtureDecodes() throws {
        let ended = try XCTUnwrap(notices("myRun.cancelled").endedRun)
        XCTAssertEqual(ended, EndedRun(runId: "demo_run_001", state: .cancelled, serviceDate: "2026-11-25",
                                       endedAt: Date(timeIntervalSince1970: 1_795_608_600),
                                       replacementPending: false, validUntil: endOfDay))
    }

    func testReplacementPendingCompletedAndNoticesDecode() throws {
        XCTAssertEqual(try notices("myRun.cancelledReplacementPending").endedRun?.replacementPending, true)
        XCTAssertEqual(try notices("myRun.completed").endedRun?.state, .completed)
        XCTAssertEqual(try notices("myRun.noService").serviceNotice?.kind, .noService)
        let late = try XCTUnwrap(notices("myRun.lateStart").serviceNotice)
        XCTAssertEqual(late.kind, .lateStart(minutes: 20))
        XCTAssertEqual(late.validUntil, endOfDay)
    }

    /// Older deployments omit the new keys; today's responses still decode in this build.
    func testMissingKeysMeanNoNotices() throws {
        XCTAssertEqual(try notices(data: removing(["endedRun", "serviceNotice"], from: "myRun.noActiveRun")), .none)
        XCTAssertEqual(try notices(data: removing(["serviceNotice"], from: "myRun.ready")), .none)
    }

    /// A malformed entry is an error, never "no trip" in place of a cancellation.
    func testMalformedEntriesAreErrors() throws {
        for (name, path, value) in [
            ("myRun.cancelled", "endedRun.state", "active" as Any),
            ("myRun.cancelled", "endedRun.replacement", "active"),
            ("myRun.lateStart", "serviceNotice.lateStartMinutes", NSNull()),
            ("myRun.noService", "serviceNotice.lateStartMinutes", 5),
            ("myRun.noService", "serviceNotice.serviceDate", "tomorrow")
        ] {
            let data = try ContractFixture.patched(name, path, value)
            XCTAssertThrowsError(try notices(data: data), "\(path) = \(value)")
        }
    }

    // MARK: Expiry

    func testNoticesDisappearWhenTheirDayEnds() throws {
        var both = try notices("myRun.cancelled")
        both.serviceNotice = try notices("myRun.noService").serviceNotice
        XCTAssertEqual(both.current(at: endOfDay.addingTimeInterval(-1)), both)
        XCTAssertEqual(both.current(at: endOfDay), .none)
        XCTAssertEqual(StatusCopy.noTrip(both.current(at: endOfDay)).title, "No trip right now")
    }

    /// A new verified clock must not drop today's notices (`RunSnapshot.with(clock:)`).
    func testVerifiedClockKeepsNotices() throws {
        let data = try ContractFixture.data("myRun.lateStart")
        let snapshot = try DomainMapping.snapshot(from: JSONDecoder().decode(MyRunDTO.self, from: data),
                                                  receivedAt: received)
        guard case let .noActiveRun(_, _, clock, notices) = snapshot.with(clock: .deviceOnly) else {
            return XCTFail("expected no active run")
        }
        XCTAssertEqual(clock, .deviceOnly)
        XCTAssertEqual(notices.serviceNotice?.kind, .lateStart(minutes: 20))
    }

    // MARK: Copy

    func testNoTripCopy() throws {
        // Fixture, title, and a phrase from the detail.
        let cases = [
            ["myRun.cancelled", "Trip cancelled", "The school cancelled today's trip"],
            ["myRun.cancelledReplacementPending", "Trip cancelled", "is sending a replacement bus"],
            ["myRun.completed", "Trip completed", "has finished"],
            ["myRun.noService", "No service today", "teacher workday"],
            ["myRun.lateStart", "Starts 20 minutes late today", "because of fog"],
            ["myRun.noActiveRun", "No trip right now", "isn't running"]
        ]
        for item in cases {
            let (name, title, detail) = (item[0], item[1], item[2])
            let copy = StatusCopy.noTrip(try notices(name), timeZone: newYork)
            XCTAssertEqual(copy.title, title, name)
            XCTAssertTrue(copy.detail.contains(detail), "\(name): \(copy.detail)")
            XCTAssertEqual(copy.tone, .unknown, name)
        }
    }

    func testPendingReplacementIsNotOnTheWay() throws {
        let copy = StatusCopy.noTrip(try notices("myRun.cancelledReplacementPending"))
        XCTAssertFalse(copy.detail.localizedCaseInsensitiveContains("on the way"))
    }

    func testCancelledSaysWhen() throws {
        let copy = StatusCopy.noTrip(try notices("myRun.cancelled"), timeZone: newYork)
        let cancelledAt = StatusCopy.capturedTime(Date(timeIntervalSince1970: 1_795_608_600), timeZone: newYork)
        XCTAssertEqual(copy.age, "Cancelled at \(cancelledAt)")
    }
}
