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
        XCTAssertEqual(FreshnessPolicy.etaValidFor * 1000, json["etaValidForMs"])
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

    private let base = ContinuousClock.now

    /// A verified clock pinned to `serverNow` at monotonic `base`.
    private func verified(serverNow: Date, uncertainty: TimeInterval = 0) -> ServerClock {
        ServerClock(serverNow: serverNow, receivedAt: serverNow, isVerified: true,
                    monotonicAt: base, uncertainty: uncertainty)
    }

    /// Review regression: phone 15 min slow + a cached snapshot whose serverNowMs is 1 s after
    /// capture, for a position that is really 10 min old. The freshness the screen uses must not
    /// say fresh while unverified; with verified server time it is stale.
    func testCachedSnapshotAndSlowPhoneNeverLookFresh() {
        let trueNow = captured.addingTimeInterval(600)
        let phoneNow = trueNow.addingTimeInterval(-900)
        let cached = ServerClock(serverNow: captured.addingTimeInterval(1), receivedAt: phoneNow)
        XCTAssertNotEqual(position().freshness(at: phoneNow, clock: cached), .fresh)
        let run = PreviewFixtures.run(position: position())
        XCTAssertNotEqual(LivePresentation.make(run: run, clock: cached, now: phoneNow), .live(.fresh))

        let clock = verified(serverNow: trueNow)
        XCTAssertEqual(position().age(at: phoneNow, clock: clock, monotonicNow: base), 600, accuracy: 0.001)
        XCTAssertEqual(position().freshness(at: phoneNow, clock: clock, monotonicNow: base), .stale)
    }

    /// Review regression: verified while the phone was 10 min fast, then the phone clock is
    /// corrected. Verified time follows monotonic elapsed time, so the wall-clock jump is ignored.
    func testPhoneClockCorrectionAfterVerificationDoesNotMakeOldDataFresh() {
        let trueNow = captured.addingTimeInterval(600)
        let clock = verified(serverNow: trueNow)
        let correctedPhoneNow = trueNow.addingTimeInterval(5) // the phone jumped back 10 min to true time
        let later = base.advanced(by: .seconds(5))
        XCTAssertEqual(position().age(at: correctedPhoneNow, clock: clock, monotonicNow: later), 605, accuracy: 0.001)
        XCTAssertEqual(position().freshness(at: correctedPhoneNow, clock: clock, monotonicNow: later), .stale)
    }

    func testVerifiedClockAdvancesMonotonically() {
        let clock = verified(serverNow: captured.addingTimeInterval(10))
        let anyWallTime = Date.distantFuture // ignored once verified
        XCTAssertEqual(position().age(at: anyWallTime, clock: clock, monotonicNow: base.advanced(by: .seconds(20))),
                       30, accuracy: 0.001)
        XCTAssertEqual(position().freshness(at: anyWallTime, clock: clock, monotonicNow: base), .fresh)
    }

    func testUncertaintyOnlyMakesAPositionOlder() {
        let clock = verified(serverNow: captured.addingTimeInterval(25), uncertainty: 6)
        XCTAssertEqual(position().age(at: .now, clock: clock, monotonicNow: base), 31, accuracy: 0.001)
        XCTAssertEqual(position().freshness(at: .now, clock: clock, monotonicNow: base), .aging)
    }

    func testVerifiedClockFromARoundTripUsesTheMidpoint() throws {
        let dto = try ContractFixture.decode(ServerTimeDTO.self, "serverTime")
        let clock = try DomainMapping.verifiedClock(from: dto, sentAt: base, receivedAt: base.advanced(by: .seconds(2)),
                                                    receivedWallTime: Date())
        XCTAssertTrue(clock.isVerified)
        XCTAssertEqual(clock.monotonicAt, base.advanced(by: .seconds(1)))
        XCTAssertEqual(clock.uncertainty, 1, accuracy: 0.000_1)
        XCTAssertEqual(clock.serverNow.timeIntervalSince1970, 1_795_609_085.5, accuracy: 0.000_1)
    }

    /// Review regression: a response delayed 240 s would make a verified clock 120 s slow.
    /// Slow round trips are rejected, so the app stays unverified and never shows fresh.
    func testSlowRoundTripIsRejected() throws {
        let dto = try ContractFixture.decode(ServerTimeDTO.self, "serverTime")
        XCTAssertThrowsError(try DomainMapping.verifiedClock(
            from: dto, sentAt: base, receivedAt: base.advanced(by: .seconds(240)), receivedWallTime: Date()))
    }

    func testAgeText() {
        XCTAssertEqual(AgeFormatter.updatedText(age: 2), "Updated just now")
        XCTAssertEqual(AgeFormatter.updatedText(age: 12.9), "Updated 12s ago")
        XCTAssertEqual(AgeFormatter.updatedText(age: 185), "Updated 3 min ago")
    }
}
