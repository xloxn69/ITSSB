import XCTest
@testable import ITSSB

/// The driver's delay report: decoded from the shared fixture, category only,
/// shown with its age, never as an ETA, and gone once it expires (docs/08 §9.4).
final class ReportedDelayTests: XCTestCase {
    private func run(_ name: String, _ patch: String? = nil, _ value: Any? = nil) throws -> TrackedRun {
        let data = try patch.map { try ContractFixture.patched(name, $0, value as Any) } ?? ContractFixture.data(name)
        let dto = try JSONDecoder().decode(MyRunDTO.self, from: data)
        guard case let .ready(_, _, run, _) = try DomainMapping.snapshot(from: dto, receivedAt: Date()) else {
            throw XCTSkip("not ready")
        }
        return run
    }

    private func line(_ run: TrackedRun, _ offset: TimeInterval) -> String? {
        let mono = ContinuousClock.now
        let server = run.reportedDelay!.reportedAt.addingTimeInterval(offset)
        let clock = ServerClock(serverNow: server, receivedAt: server, isVerified: true, monotonicAt: mono)
        return ReportedDelayPresentation.line(run: run, clock: clock, now: server, monotonicNow: mono)
    }

    func testDecodesTheFixtureWithNoEta() throws {
        let run = try run("myRun.reportedDelay")
        XCTAssertNil(run.eta)
        let delay = try XCTUnwrap(run.reportedDelay)
        XCTAssertEqual(delay.category, .traffic)
        XCTAssertEqual(delay.minutes, 10)
        XCTAssertEqual(delay.reportedAt.timeIntervalSince1970, 1_795_608_900, accuracy: 0.001)
    }

    func testAnOlderBackendWithoutTheFieldStillDecodes() throws {
        XCTAssertNil(try run("myRun.ready").reportedDelay)
    }

    func testAMalformedReportIsDroppedAndTheRunKept() throws {
        for (key, value) in [("category", "late"), ("source", "staff")] as [(String, Any)] {
            let bad = try run("myRun.reportedDelay", "run.reportedDelay.\(key)", value)
            XCTAssertNil(bad.reportedDelay, key)
            XCTAssertEqual(bad.busLabel, "Bus 12")
        }
        XCTAssertNil(try run("myRun.reportedDelay", "run.reportedDelay.minutes", 2.5).reportedDelay)
    }

    func testShowsTheCategoryMinutesAndAge() throws {
        XCTAssertEqual(line(try run("myRun.reportedDelay"), 180),
                       "Driver reported a delay (traffic), about 10 min — reported 3 min ago")
    }

    func testDisappearsAtValidUntil() throws {
        let run = try run("myRun.reportedDelay")
        let validFor = run.reportedDelay!.validUntil.timeIntervalSince(run.reportedDelay!.reportedAt)
        XCTAssertNotNil(line(run, validFor - 1))
        XCTAssertNil(line(run, validFor))
    }

    func testNeverShownOnARunThatIsNotActive() throws {
        XCTAssertNil(line(try run("myRun.reportedDelay", "run.state", "completed"), 60))
    }

    func testCategoryWordsMatchTheContract() {
        XCTAssertEqual(RunReportCategory.allCases.map(\.rawValue),
                       ["traffic", "mechanical", "weather", "student_incident", "other"])
        let none = ReportedDelay(category: .mechanical, minutes: nil, reportedAt: Date(), validUntil: Date())
        XCTAssertEqual(ReportedDelayPresentation.text(none), "Driver reported a delay (mechanical problem)")
    }
}
