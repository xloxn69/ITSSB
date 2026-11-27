import XCTest
@testable import ITSSB

/// Decodes the shared notification fixtures (docs/08 §9–10).
final class NotificationDecodingTests: XCTestCase {
    func testPreferenceFixturesDecode() throws {
        guard case let .ready(ready) = try ContractFixture.decode(MyPreferenceDTO.self, "myPreference.ready") else {
            return XCTFail("expected ready")
        }
        XCTAssertTrue(ready.preference.approachingEnabled)
        XCTAssertEqual(ready.preference.approachingMinutes, 5)
        XCTAssertEqual(ready.preference.updatedAtMs, 1_795_600_000_000)
        let defaultsDTO = try ContractFixture.decode(MyPreferenceDTO.self, "myPreference.default")
        guard case let .ready(defaults) = defaultsDTO else {
            return XCTFail("expected ready")
        }
        XCTAssertFalse(defaults.preference.approachingEnabled)
        XCTAssertNil(defaults.preference.updatedAtMs)
    }

    func testSaveAndRegisterFixturesDecode() throws {
        guard case let .saved(saved) = try ContractFixture.decode(SetPreferencesDTO.self, "setPreferences.saved") else {
            return XCTFail("expected saved")
        }
        XCTAssertEqual(saved.preference.approachingMinutes, 7)
        guard case let .registered(registered) = try ContractFixture.decode(
            RegisterDeviceDTO.self, "registerDevice.registered"
        ) else {
            return XCTFail("expected registered")
        }
        XCTAssertTrue(registered.pushEnabled)
    }

    func testAlertsFixturesDecode() throws {
        guard case let .ready(ready) = try ContractFixture.decode(MyAlertsDTO.self, "myAlerts.ready") else {
            return XCTFail("expected ready")
        }
        let alert = try XCTUnwrap(ready.alerts.first)
        XCTAssertEqual(alert.type, "approaching")
        XCTAssertEqual(alert.stopLabel, "Oak & Pine")
        XCTAssertEqual(alert.predictionGeneratedAtMs, 1_795_609_085_450)
        guard case let .ready(empty) = try ContractFixture.decode(MyAlertsDTO.self, "myAlerts.empty") else {
            return XCTFail("expected ready")
        }
        XCTAssertTrue(empty.alerts.isEmpty)
    }
}
