import SwiftUI
import XCTest
@testable import ITSSBDesignSystem

final class ColorHexTests: XCTestCase {
    func testValidHexParses() {
        XCTAssertNotNil(Color(hex: "F2B300"))
        XCTAssertNotNil(Color(hex: "#F2B300"))
        XCTAssertNotNil(Color(hex: "80F2B300"))
    }

    func testInvalidHexIsRejected() {
        XCTAssertNil(Color(hex: ""))
        XCTAssertNil(Color(hex: "F2B"))
        XCTAssertNil(Color(hex: "GGGGGG"))
    }

    func testSpacingIsOnFourPointGrid() {
        for value in [AppSpacing.xs, AppSpacing.sm, AppSpacing.md, AppSpacing.lg, AppSpacing.xl, AppSpacing.xxl] {
            XCTAssertEqual(value.truncatingRemainder(dividingBy: 4), 0)
        }
    }
}
