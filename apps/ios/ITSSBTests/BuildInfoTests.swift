import XCTest
@testable import ITSSB

/// Build identity (docs/14 §1-2): the installed app names its version, build,
/// commit and environment, and never claims to be production by default.
final class BuildInfoTests: XCTestCase {
    func testReadsStampedValues() {
        let info = BuildInfo(infoDictionary: [
            "CFBundleShortVersionString": "0.2.0",
            "CFBundleVersion": "7",
            "ITSSBEnvironment": "staging",
            "ITSSBSourceRevision": "abc1234def5678"
        ])
        XCTAssertEqual(info.version, "0.2.0")
        XCTAssertEqual(info.build, "7")
        XCTAssertEqual(info.environment, .staging)
        XCTAssertEqual(info.sourceRevision, "abc1234def5678")
        XCTAssertEqual(info.summary, "0.2.0 (7) abc1234 staging")
    }

    func testMissingOrUnknownEnvironmentIsDevelopment() {
        XCTAssertEqual(BuildInfo(infoDictionary: [:]).environment, .development)
        XCTAssertEqual(BuildInfo(infoDictionary: ["ITSSBEnvironment": "prod"]).environment, .development)
        XCTAssertEqual(BuildInfo(infoDictionary: ["ITSSBEnvironment": ""]).environment, .development)
    }

    func testUnstampedRevisionStaysUnknown() {
        let info = BuildInfo(infoDictionary: ["ITSSBSourceRevision": ""])
        XCTAssertNil(info.sourceRevision)
        XCTAssertTrue(info.summary.contains("unknown"))
    }

    /// The app's Info.plist takes its version from project.yml, not a
    /// hardcoded "1.0" that would make every build look the same.
    func testAppBundleUsesProjectVersion() {
        let info = BuildInfo.fromBundle()
        XCTAssertEqual(info.version, "0.1.0")
        XCTAssertEqual(info.environment, .development)
    }
}
