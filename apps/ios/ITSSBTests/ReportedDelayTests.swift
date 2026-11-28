import XCTest
@testable import ITSSB

/// The driver's delay report: decoded from the shared fixture, category only,
/// shown with its age, never as an ETA, and gone once it expires (docs/08 §9.4).
final class ReportedDelayTests: XCTestCase {
    private func fixtureRun(_ name: String, _ patch: String? = nil, _ value: Any? = nil) throws -> TrackedRun {
        let data: Data
        if let patch {
            data = try ContractFixture.patched(name, patch, value as Any)
        } else {
            data = try ContractFixture.data(name)
        }
        let dto: MyRunDTO = try JSONDecoder().decode(MyRunDTO.self, from: data)
        let snapshot: RunSnapshot = try DomainMapping.snapshot(from: dto, receivedAt: Date())
        guard case let .ready(_, _, tracked, _, _) = snapshot else {
            throw XCTSkip("not ready")
        }
        return tracked
    }

    private func line(_ run: TrackedRun, _ offset: TimeInterval) -> String? {
        let mono = ContinuousClock.now
        let server = run.reportedDelay!.reportedAt.addingTimeInterval(offset)
        let clock = ServerClock(serverNow: server, receivedAt: server, isVerified: true, monotonicAt: mono)
        return ReportedDelayPresentation.line(run: run, clock: clock, now: server, monotonicNow: mono)
    }

    func testDecodesTheFixtureWithNoEta() throws {
        let run = try fixtureRun("myRun.reportedDelay")
        XCTAssertNil(run.eta)
        let delay = try XCTUnwrap(run.reportedDelay)
        XCTAssertEqual(delay.category, .traffic)
        XCTAssertEqual(delay.minutes, 10)
        XCTAssertEqual(delay.reportedAt.timeIntervalSince1970, 1_795_608_900, accuracy: 0.001)
    }

    func testAnOlderBackendWithoutTheFieldStillDecodes() throws {
        XCTAssertNil(try fixtureRun("myRun.ready").reportedDelay)
    }

    func testAMalformedReportIsDroppedAndTheRunKept() throws {
        let badValues: [(key: String, value: String)] = [("category", "late"), ("source", "staff")]
        for (key, value) in badValues {
            let bad = try fixtureRun("myRun.reportedDelay", "run.reportedDelay.\(key)", value)
            XCTAssertNil(bad.reportedDelay, key)
            XCTAssertEqual(bad.busLabel, "Bus 12")
        }
        XCTAssertNil(try fixtureRun("myRun.reportedDelay", "run.reportedDelay.minutes", 2.5).reportedDelay)
    }

    func testShowsTheCategoryMinutesAndAge() throws {
        XCTAssertEqual(line(try fixtureRun("myRun.reportedDelay"), 180),
                       "Driver reported a delay (traffic), about 10 min — reported 3 min ago")
    }

    func testDisappearsAtValidUntil() throws {
        let run = try fixtureRun("myRun.reportedDelay")
        let validFor = run.reportedDelay!.validUntil.timeIntervalSince(run.reportedDelay!.reportedAt)
        XCTAssertNotNil(line(run, validFor - 1))
        XCTAssertNil(line(run, validFor))
    }

    func testNeverShownOnARunThatIsNotActive() throws {
        XCTAssertNil(line(try fixtureRun("myRun.reportedDelay", "run.state", "completed"), 60))
    }

    func testCategoryWordsMatchTheContract() {
        XCTAssertEqual(RunReportCategory.allCases.map(\.rawValue),
                       ["traffic", "mechanical", "weather", "student_incident", "other"])
        let none = ReportedDelay(category: .mechanical, minutes: nil, reportedAt: Date(), validUntil: Date())
        XCTAssertEqual(ReportedDelayPresentation.text(none), "Driver reported a delay (mechanical problem)")
    }

    func testNotShownBeforeServerTimeIsVerified() throws {
        // A cached result: server time one minute after the report, unverified,
        // with the phone clock far behind. Unverified time must never age it.
        let run = try fixtureRun("myRun.reportedDelay")
        let reportedAt = run.reportedDelay!.reportedAt
        let cached = ServerClock(serverNow: reportedAt.addingTimeInterval(60),
                                 receivedAt: reportedAt.addingTimeInterval(-7200),
                                 isVerified: false, monotonicAt: nil)
        XCTAssertNil(ReportedDelayPresentation.line(run: run, clock: cached,
                                                    now: reportedAt.addingTimeInterval(-7200)))
        XCTAssertNil(ReportedDelayPresentation.line(run: run, clock: cached, now: reportedAt.addingTimeInterval(60)))
    }
}
