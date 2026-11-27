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
        XCTAssertNotEqual(info.version, "1.0", "Info.plist must use MARKETING_VERSION")
        XCTAssertNotNil(info.version?.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression))
        XCTAssertNotNil(info.build)
        XCTAssertEqual(info.environment, .development)
    }
}

/// docs/14 §2: a non-production build says so on screen; production shows nothing.
final class EnvironmentLabelTests: XCTestCase {
    func testLabelsEveryNonProductionBuild() {
        let label = { (env: String) in BuildInfo(infoDictionary: ["ITSSBEnvironment": env]).environmentLabel }
        XCTAssertEqual(label("development"), "Development build")
        XCTAssertEqual(label("staging"), "Staging build")
        XCTAssertEqual(BuildInfo(infoDictionary: [:]).environmentLabel, "Development build")
    }

    func testProductionShowsNoLabel() {
        XCTAssertNil(BuildInfo(infoDictionary: ["ITSSBEnvironment": "production"]).environmentLabel)
    }
}
