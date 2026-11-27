import XCTest
@testable import ITSSB

private struct Registration {
    let token: String?
    let permission: PushPermission
    let installationId: String
}

private final class RecordingNotificationSource: NotificationSource, @unchecked Sendable {
    var registrations: [Registration] = []
    var saveResult: Result<NotificationPreference, Error> = .failure(NotificationError.rejected)

    func alerts() -> AsyncThrowingStream<[AlertItem]?, Error> {
        AsyncThrowingStream { $0.yield([]) }
    }

    func preference(assignmentId: String) -> AsyncThrowingStream<NotificationPreference?, Error> {
        AsyncThrowingStream {
            $0.yield(NotificationPreference(assignmentId: assignmentId, approachingEnabled: false,
                                            approachingMinutes: 5, updatedAt: nil))
        }
    }

    func savePreference(assignmentId: String, enabled: Bool, minutes: Int) async throws -> NotificationPreference {
        try saveResult.get()
    }

    func registerDevice(installationId: String, token: String?, environment: PushEnvironment,
                        permission: PushPermission) async throws -> Bool {
        registrations.append(Registration(token: token, permission: permission, installationId: installationId))
        return token != nil && permission.allowsAlerts
    }
}

private struct FixedPermission: PushAuthorizing {
    let value: PushPermission
    func currentPermission() async -> PushPermission { value }
    func requestPermission() async -> PushPermission { value }
}

private final class MemoryIds: InstallationIdStoring, @unchecked Sendable {
    var value: String?
    func load() -> String? { value }
    func save(_ id: String) { value = id }
}

@MainActor
final class AlertsTests: XCTestCase {
    private func defaults() -> MemoryIds { MemoryIds() }

    func testInboxFixtureMapsWithItsEstimateTime() throws {
        let items = try XCTUnwrap(NotificationMapping.alerts(from: ContractFixture.decode(MyAlertsDTO.self,
                                                                                            "myAlerts.ready")))
        XCTAssertEqual(items.first?.stopLabel, "Oak & Pine")
        XCTAssertEqual(items.first?.predictionGeneratedAt, WireTime.date(fromEpochMs: 1_795_609_085_450))
    }

    func testUnknownAlertTypeIsRejected() throws {
        let data = try ContractFixture.patched("myAlerts.ready", "alerts", [[
            "alertId": "a", "type": "something_else", "assignmentId": "x", "runId": "r", "stopLabel": "s",
            "createdAtMs": 1, "predictedArrivalAtMs": 1, "predictionGeneratedAtMs": 1
        ]])
        XCTAssertThrowsError(try NotificationMapping.alerts(from: JSONDecoder().decode(MyAlertsDTO.self, from: data)))
    }

    func testTokenIsLowercaseHex() {
        XCTAssertEqual(NotificationMapping.hex(Data([0x0a, 0xff, 0x10])), "0aff10")
    }

    func testDeniedPermissionRegistersWithoutAToken() async {
        let source = RecordingNotificationSource()
        var asked = 0
        let registrar = PushRegistrar(source: source, authorizing: FixedPermission(value: .denied),
                                      ids: defaults(), environment: .sandbox) { asked += 1 }
        await registrar.refresh()
        await registrar.didRegister(deviceToken: Data([1, 2]))
        XCTAssertEqual(asked, 0)
        XCTAssertEqual(source.registrations.last?.token, nil)
        XCTAssertEqual(source.registrations.last?.permission, .denied)
        XCTAssertFalse(registrar.pushEnabled)
    }

    func testAuthorizedPermissionSendsTheTokenWithAStableInstallation() async {
        let source = RecordingNotificationSource()
        let store = defaults()
        let registrar = PushRegistrar(source: source, authorizing: FixedPermission(value: .authorized),
                                      ids: store, environment: .sandbox) {}
        await registrar.refresh()
        await registrar.didRegister(deviceToken: Data([0xab, 0xcd]))
        XCTAssertEqual(source.registrations.last?.token, "abcd")
        XCTAssertTrue(registrar.pushEnabled)
        let again = PushRegistrar(source: source, authorizing: FixedPermission(value: .authorized),
                                  ids: store, environment: .sandbox) {}
        XCTAssertEqual(again.installationId, registrar.installationId)
    }

    func testPreferenceChangesOnlyWhenTheServerConfirms() async throws {
        let source = RecordingNotificationSource()
        let model = AlertsViewModel(tracking: PreviewLiveRunSource(scenario: .live), notifications: source)
        model.start()
        try await waitUntil { model.preferences["demo_assignment_001"] != nil }
        await model.save(assignmentId: "demo_assignment_001", enabled: true, minutes: 7)
        XCTAssertEqual(model.preferences["demo_assignment_001"]?.approachingEnabled, false)
        XCTAssertTrue(model.saveFailed.contains("demo_assignment_001"))

        source.saveResult = .success(NotificationPreference(assignmentId: "demo_assignment_001",
                                                            approachingEnabled: true, approachingMinutes: 7,
                                                            updatedAt: Date()))
        await model.save(assignmentId: "demo_assignment_001", enabled: true, minutes: 7)
        XCTAssertEqual(model.preferences["demo_assignment_001"]?.approachingMinutes, 7)
        XCTAssertFalse(model.saveFailed.contains("demo_assignment_001"))
        model.stop()
    }

    func testSignOutStopsPushesAndIgnoresLateTokens() async {
        let source = RecordingNotificationSource()
        let registrar = PushRegistrar(source: source, authorizing: FixedPermission(value: .authorized),
                                      ids: defaults(), environment: .sandbox) {}
        await registrar.refresh()
        await registrar.didRegister(deviceToken: Data([0xab]))
        XCTAssertEqual(source.registrations.last?.token, "ab")
        await registrar.deactivate()
        XCTAssertNil(source.registrations.last?.token)
        XCTAssertFalse(registrar.pushEnabled)
        let count = source.registrations.count
        await registrar.didRegister(deviceToken: Data([0xcd])) // arrives after sign-out
        XCTAssertEqual(source.registrations.count, count)
    }

    func testNotificationTapCarriesOnlyTheAssignment() {
        XCTAssertEqual(NotificationRouter.assignmentId(from: ["itssb": ["type": "approaching",
                                                                         "assignmentId": "a1"]]), "a1")
        XCTAssertNil(NotificationRouter.assignmentId(from: ["aps": ["alert": "x"]]))
    }

    private func waitUntil(_ condition: @escaping () -> Bool) async throws {
        for _ in 0..<200 where !condition() { await Task.yield() }
        XCTAssertTrue(condition())
    }
}
