import XCTest
@testable import ITSSB

/// The arrival estimate is shown only with its age, and disappears whenever its
/// inputs can't support it (docs/08 §8, docs/10 §4).
final class EtaPresentationTests: XCTestCase {
    private let utc = TimeZone(identifier: "UTC")!

    private func readyRun(_ patch: String? = nil, _ value: Any? = nil) throws -> TrackedRun {
        let data = try patch.map { try ContractFixture.patched("myRun.ready", $0, value as Any) }
            ?? ContractFixture.data("myRun.ready")
        let dto = try JSONDecoder().decode(MyRunDTO.self, from: data)
        guard case let .ready(_, _, run, _) = try DomainMapping.snapshot(from: dto, receivedAt: Date()) else {
            throw XCTSkip("not ready")
        }
        return run
    }

    /// The estimate as shown at verified server time `offset` seconds after the position was captured.
    private func eta(_ run: TrackedRun, _ offset: TimeInterval, verified: Bool = true) -> EtaPresentation? {
        let mono = ContinuousClock.now
        let server = run.position!.capturedAt.addingTimeInterval(offset)
        let clock = ServerClock(serverNow: server, receivedAt: server, isVerified: verified,
                                monotonicAt: verified ? mono : nil)
        return EtaPresentation.make(run: run, clock: clock, now: server, monotonicNow: mono, timeZone: utc)
    }

    func testShowsTheEstimateWithWhenItWasMade() throws {
        let run = try readyRun()
        let view = try XCTUnwrap(eta(run, 15))
        XCTAssertEqual(view.headline, "About 6 min")
        XCTAssertEqual(view.madeText, "Estimate made 14s ago")
    }

    func testNeverShownBeforeVerifiedTime() throws {
        XCTAssertNil(eta(try readyRun(), 5, verified: false))
    }

    func testDisappearsAtValidUntilWithoutAnUpdate() throws {
        let run = try readyRun()
        let validFor = run.eta!.validUntil.timeIntervalSince(run.position!.capturedAt)
        XCTAssertEqual(validFor, FreshnessPolicy.etaValidFor, accuracy: 0.001)
        XCTAssertNotNil(eta(run, validFor - 1))
        XCTAssertNil(eta(run, validFor))
    }

    func testWithheldWhenThePositionIsStaleEvenWithALongValidity() throws {
        let run = try readyRun("run.eta.validUntilMs", 1_795_609_085_000 + 600_000)
        XCTAssertNil(eta(run, FreshnessPolicy.staleAfter))
    }

    func testWithheldWhenMadeFromAnotherPosition() throws {
        XCTAssertNil(eta(try readyRun("run.eta.sourceEventId", "another-event"), 5))
    }

    func testWithheldWhenTheRunEndedOrTheStopIsReached() throws {
        XCTAssertNil(eta(try readyRun("run.state", "completed"), 5))
        XCTAssertNil(eta(try readyRun("run.state", "cancelled"), 5))
        let atStop = try readyRun("run.assignedStop.status", "at_stop")
        XCTAssertNil(eta(atStop, 5))
        XCTAssertEqual(EtaPresentation.stopProgress(atStop), "The bus is at your stop.")
        let passed = try readyRun("run.assignedStop.status", "passed")
        XCTAssertEqual(EtaPresentation.stopProgress(passed), "The bus has passed your stop.")
    }

    func testNeverCountsDownToAFalseArrivingNow() throws {
        let run = try readyRun("run.eta.arrivalAtMs", 1_795_609_085_000 + 20_000)
        XCTAssertEqual(eta(run, 30)?.headline, "Less than a minute")
    }

    func testMalformedEstimateIsDroppedNotTheRun() throws {
        let run = try readyRun("run.eta.validUntilMs", 1)
        XCTAssertNil(run.eta)
        XCTAssertNotNil(run.position)
    }
}
