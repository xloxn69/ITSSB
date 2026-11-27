import XCTest
@testable import ITSSB

/// Timestamp conversion, the stale cutoff, and clock-offset handling.
final class FreshnessTests: XCTestCase {
    private let captured = Date(timeIntervalSince1970: 1_795_609_085)

    private func position(capturedAt: Date? = nil) -> LivePosition {
        LivePosition(eventId: "e", latitude: 34.1, longitude: -83.98, speedMps: nil, headingDegrees: nil,
                     horizontalAccuracyM: nil, capturedAt: capturedAt ?? captured,
                     receivedAt: (capturedAt ?? captured).addingTimeInterval(0.4))
    }

    func testEpochMillisecondsConvertExplicitly() {
        XCTAssertEqual(WireTime.date(fromEpochMs: 1_795_609_085_000).timeIntervalSince1970, 1_795_609_085)
        XCTAssertEqual(WireTime.date(fromEpochMs: 1_795_609_085_400).timeIntervalSince1970,
                       1_795_609_085.4, accuracy: 0.000_1)
    }

    func testThresholdsMatchTheSharedContract() throws {
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: ContractFixture.data("freshnessPolicy")) as? [String: Double])
        XCTAssertEqual(FreshnessPolicy.agingAfter * 1000, json["positionAgingAfterMs"])
        XCTAssertEqual(FreshnessPolicy.staleAfter * 1000, json["positionStaleAfterMs"])
    }

    func testStaleCutoffBoundaries() {
        XCTAssertEqual(Freshness(age: 0), .fresh)
        XCTAssertEqual(Freshness(age: 29.999), .fresh)
        XCTAssertEqual(Freshness(age: 30), .aging)
        XCTAssertEqual(Freshness(age: 119.999), .aging)
        XCTAssertEqual(Freshness(age: 120), .stale)
    }

    func testPositionBecomesStaleWithTimeAlone() {
        let pos = position()
        XCTAssertEqual(pos.freshness(at: captured.addingTimeInterval(5)), .fresh)
        XCTAssertEqual(pos.freshness(at: captured.addingTimeInterval(45)), .aging)
        XCTAssertEqual(pos.freshness(at: captured.addingTimeInterval(600)), .stale)
    }

    func testAgeNeverNegative() {
        XCTAssertEqual(position().age(at: captured.addingTimeInterval(-10)), 0)
    }

    func testPhoneClockBehindServerUsesServerTime() {
        // Phone is 90s slow: server says 10s after capture while the phone thinks it is 80s before.
        let phoneNow = captured.addingTimeInterval(-80)
        let clock = ServerClock(serverNow: captured.addingTimeInterval(10), receivedAt: phoneNow)
        XCTAssertEqual(position().age(at: phoneNow, clock: clock), 10, accuracy: 0.001)
        // Two minutes later on the phone, the position is stale even with no new update.
        XCTAssertEqual(position().freshness(at: phoneNow.addingTimeInterval(120), clock: clock), .stale)
    }

    func testPhoneClockAheadNeverMakesAPositionFresher() {
        // Phone is 60s fast. A cached result's old serverNowMs must not shrink the age.
        let phoneNow = captured.addingTimeInterval(70)
        let clock = ServerClock(serverNow: captured.addingTimeInterval(10), receivedAt: phoneNow)
        XCTAssertEqual(position().age(at: phoneNow, clock: clock), 70, accuracy: 0.001)
    }

    /// Review regression: phone 15 min slow + a cached snapshot whose serverNowMs is 1 s after
    /// capture, for a position that is really 10 min old. Unverified, it must not read as fresh;
    /// with verified server time it is stale.
    func testCachedSnapshotAndSlowPhoneNeverLookFresh() {
        let trueNow = captured.addingTimeInterval(600)
        let phoneNow = trueNow.addingTimeInterval(-900)
        let cached = ServerClock(serverNow: captured.addingTimeInterval(1), receivedAt: phoneNow)
        let run = PreviewFixtures.run(position: position())
        XCTAssertNotEqual(LivePresentation.make(run: run, clock: cached, now: phoneNow), .live(.fresh))

        // tracking:serverTime answered trueNow when the phone read phoneNow.
        let verified = ServerClock(serverNow: trueNow, receivedAt: phoneNow, isVerified: true)
        XCTAssertEqual(position().age(at: phoneNow, clock: verified), 600, accuracy: 0.001)
        XCTAssertEqual(LivePresentation.make(run: run, clock: verified, now: phoneNow), .stale)
    }

    func testVerifiedClockIsUsedExactlyWhenThePhoneIsFast() {
        // Phone 60 s fast; verified server time corrects it rather than taking the larger age.
        let phoneNow = captured.addingTimeInterval(70)
        let verified = ServerClock(serverNow: captured.addingTimeInterval(10), receivedAt: phoneNow, isVerified: true)
        XCTAssertEqual(position().age(at: phoneNow, clock: verified), 10, accuracy: 0.001)
    }

    func testVerifiedClockFromARoundTripUsesTheMidpoint() throws {
        let dto = try ContractFixture.decode(ServerTimeDTO.self, "serverTime")
        let sent = Date(timeIntervalSince1970: 1_000)
        let clock = try DomainMapping.verifiedClock(from: dto, sentAt: sent, receivedAt: sent.addingTimeInterval(2))
        XCTAssertTrue(clock.isVerified)
        XCTAssertEqual(clock.receivedAt, sent.addingTimeInterval(1))
        XCTAssertEqual(clock.serverNow.timeIntervalSince1970, 1_795_609_085.5, accuracy: 0.000_1)
    }

    func testAgeText() {
        XCTAssertEqual(AgeFormatter.updatedText(age: 2), "Updated just now")
        XCTAssertEqual(AgeFormatter.updatedText(age: 12.9), "Updated 12s ago")
        XCTAssertEqual(AgeFormatter.updatedText(age: 185), "Updated 3 min ago")
    }
}
