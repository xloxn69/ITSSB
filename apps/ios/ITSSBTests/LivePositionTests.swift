import XCTest
@testable import ITSSB

final class LivePositionTests: XCTestCase {
    private let dto = LivePositionDTO(
        latitude: 34.1, longitude: -83.98, speedMps: 7.2, headingDegrees: 95,
        capturedAtMs: 1_795_609_085_000, receivedAtMs: 1_795_609_085_400
    )

    func testConvertsEpochMillisecondsToDate() throws {
        let position = try XCTUnwrap(LivePosition(wire: dto))
        XCTAssertEqual(position.capturedAt.timeIntervalSince1970, 1_795_609_085, accuracy: 0.001)
        XCTAssertEqual(position.receivedAt.timeIntervalSince1970, 1_795_609_085.4, accuracy: 0.001)
    }

    func testRejectsInvalidCoordinates() {
        let bad = LivePositionDTO(latitude: .nan, longitude: 0, speedMps: nil, headingDegrees: nil,
                                  capturedAtMs: 0, receivedAtMs: 0)
        XCTAssertNil(LivePosition(wire: bad))
    }

    func testFreshnessAdvancesWithTimeAlone() throws {
        let position = try XCTUnwrap(LivePosition(wire: dto))
        let captured = position.capturedAt
        XCTAssertEqual(position.freshness(at: captured.addingTimeInterval(5)), .fresh)
        XCTAssertEqual(position.freshness(at: captured.addingTimeInterval(45)), .aging)
        XCTAssertEqual(position.freshness(at: captured.addingTimeInterval(600)), .stale)
    }

    func testAgeNeverNegativeWhenClocksDisagree() throws {
        let position = try XCTUnwrap(LivePosition(wire: dto))
        XCTAssertEqual(position.age(at: position.capturedAt.addingTimeInterval(-10)), 0)
    }

    func testAgeText() {
        XCTAssertEqual(AgeFormatter.updatedText(age: 2), "Updated just now")
        XCTAssertEqual(AgeFormatter.updatedText(age: 12.9), "Updated 12s ago")
        XCTAssertEqual(AgeFormatter.updatedText(age: 185), "Updated 3 min ago")
    }
}
