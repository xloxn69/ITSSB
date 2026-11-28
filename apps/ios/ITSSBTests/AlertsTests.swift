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

/// Records tokens; can hold one call open, like a slow network.
@MainActor
private final class SuspendingSource: NotificationSource, @unchecked Sendable {
    var tokens: [String?] = []
    var suspendNext = false
    var suspended: CheckedContinuation<Void, Never>?
    func resume() { suspended?.resume(); suspended = nil }

    nonisolated func alerts() -> AsyncThrowingStream<[AlertItem]?, Error> { AsyncThrowingStream { $0.yield([]) } }
    nonisolated func preference(assignmentId: String) -> AsyncThrowingStream<NotificationPreference?, Error> {
        AsyncThrowingStream { $0.yield(nil) }
    }
    nonisolated func savePreference(assignmentId: String, enabled: Bool, minutes: Int) async throws
        -> NotificationPreference { throw NotificationError.rejected }
    func registerDevice(installationId: String, token: String?, environment: PushEnvironment,
                        permission: PushPermission) async throws -> Bool {
        tokens.append(token)
        if suspendNext {
            suspendNext = false
            await withCheckedContinuation { suspended = $0 }
        }
        return token != nil
    }
}

/// Holds `currentPermission` open until released, like a slow system call.
@MainActor
private final class HeldPermission: PushAuthorizing, @unchecked Sendable {
    var held: CheckedContinuation<Void, Never>?
    var holdNext = false
    func release() { held?.resume(); held = nil }
    func currentPermission() async -> PushPermission {
        if holdNext {
            holdNext = false
            await withCheckedContinuation { held = $0 }
        }
        return .authorized
    }
    func requestPermission() async -> PushPermission { .authorized }
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
        await registrar.activate()
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
        await registrar.activate()
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
        await registrar.activate()
        await registrar.didRegister(deviceToken: Data([0xab]))
        XCTAssertEqual(source.registrations.last?.token, "ab")
        await registrar.deactivate()
        XCTAssertNil(source.registrations.last?.token)
        XCTAssertFalse(registrar.pushEnabled)
        let count = source.registrations.count
        await registrar.didRegister(deviceToken: Data([0xcd])) // arrives after sign-out
        XCTAssertEqual(source.registrations.count, count)
    }

    func testATokenArrivingDuringDeactivationIsNotRegistered() async {
        let source = SuspendingSource()
        let registrar = PushRegistrar(source: source, authorizing: FixedPermission(value: .authorized),
                                      ids: defaults(), environment: .sandbox) {}
        await registrar.activate()
        source.suspendNext = true
        let deactivation = Task { await registrar.deactivate() }
        _ = await eventuallyTrue { source.suspended != nil }
        await registrar.didRegister(deviceToken: Data([0xee])) // APNs callback mid-deactivation
        source.resume()
        await deactivation.value
        XCTAssertEqual(source.tokens, [nil, nil])
    }

    func testARefreshRacingSignOutNeverRegistersAgain() async {
        let source = SuspendingSource()
        let permission = HeldPermission()
        let registrar = PushRegistrar(source: source, authorizing: permission, ids: defaults(),
                                      environment: .sandbox) {}
        await registrar.activate()
        await registrar.didRegister(deviceToken: Data([0xab]))
        permission.holdNext = true
        let refresh = Task { await registrar.refresh() } // e.g. returning to the foreground
        _ = await eventuallyTrue { permission.held != nil }
        await registrar.deactivate()
        permission.release()
        await refresh.value
        await registrar.refresh() // a later refresh while signed out
        XCTAssertEqual(source.tokens.last, .some(nil))
        XCTAssertFalse(registrar.pushEnabled)
    }

    func testARegistrationAlreadyInFlightLandsBeforeTheSignOutDisable() async {
        let source = SuspendingSource()
        let registrar = PushRegistrar(source: source, authorizing: FixedPermission(value: .authorized),
                                      ids: defaults(), environment: .sandbox) {}
        await registrar.activate()
        source.suspendNext = true
        let register = Task { await registrar.didRegister(deviceToken: Data([0xab])) }
        _ = await eventuallyTrue { source.suspended != nil } // the token call is on the network
        let signOut = Task { await registrar.deactivate() }
        for _ in 0..<50 { await Task.yield() }
        source.resume()
        await register.value
        await signOut.value
        XCTAssertEqual(source.tokens.suffix(2), ["ab", nil]) // the disable lands last
        XCTAssertFalse(registrar.pushEnabled)
    }

    func testNotificationTapCarriesOnlyTheAssignment() {
        XCTAssertEqual(NotificationRouter.assignmentId(from: ["itssb": ["type": "approaching",
                                                                         "assignmentId": "a1"]]), "a1")
        XCTAssertNil(NotificationRouter.assignmentId(from: ["aps": ["alert": "x"]]))
    }

    private func eventuallyTrue(_ condition: @escaping () -> Bool) async -> Bool {
        for _ in 0..<500 where !condition() { await Task.yield() }
        return condition()
    }

    private func waitUntil(_ condition: @escaping () -> Bool) async throws {
        for _ in 0..<200 where !condition() { await Task.yield() }
        XCTAssertTrue(condition())
    }
}

/// Inbox and preferences the test drives by hand; saves wait until released.
@MainActor
private final class ScriptedNotificationSource: NotificationSource, @unchecked Sendable {
    private(set) var inbox: AsyncThrowingStream<[AlertItem]?, Error>.Continuation?
    /// How many times the inbox was subscribed; `inbox` is the latest.
    private(set) var inboxSubscriptions = 0
    private(set) var preferences: [String: AsyncThrowingStream<NotificationPreference?, Error>.Continuation] = [:]
    private(set) var released: [String] = []
    private var pendingSave: CheckedContinuation<NotificationPreference, Error>?

    nonisolated func alerts() -> AsyncThrowingStream<[AlertItem]?, Error> {
        let (stream, continuation) = AsyncThrowingStream<[AlertItem]?, Error>.makeStream()
        continuation.onTermination = { [weak self] _ in Task { @MainActor in self?.released.append("alerts") } }
        Task { @MainActor in
            self.inbox = continuation
            self.inboxSubscriptions += 1
        }
        return stream
    }

    nonisolated func preference(assignmentId: String) -> AsyncThrowingStream<NotificationPreference?, Error> {
        let (stream, continuation) = AsyncThrowingStream<NotificationPreference?, Error>.makeStream()
        continuation.onTermination = { [weak self] _ in
            Task { @MainActor in self?.released.append(assignmentId) }
        }
        Task { @MainActor in self.preferences[assignmentId] = continuation }
        return stream
    }

    func savePreference(assignmentId: String, enabled: Bool, minutes: Int) async throws -> NotificationPreference {
        try await withCheckedThrowingContinuation { pendingSave = $0 }
    }

    func finishSave(_ preference: NotificationPreference) {
        pendingSave?.resume(returning: preference)
        pendingSave = nil
    }

    var saveWaiting: Bool { pendingSave != nil }

    nonisolated func registerDevice(installationId: String, token: String?, environment: PushEnvironment,
                                    permission: PushPermission) async throws -> Bool { false }
}

/// docs/13 §5 A10: after sign-out nothing of account A reaches account B.
extension AlertsTests {
    private static let alex = AssignmentSummary(assignmentId: "a_alex", relationship: .guardian,
                                                studentDisplayName: "Alex Example", routeLabel: "Route 17",
                                                stopLabel: "Oak")
    private static let jordan = AssignmentSummary(assignmentId: "a_jordan", relationship: .guardian,
                                                  studentDisplayName: "Jordan Example", routeLabel: "Route 4",
                                                  stopLabel: "Elm")

    private static func preference(_ id: String, minutes: Int) -> NotificationPreference {
        NotificationPreference(assignmentId: id, approachingEnabled: true, approachingMinutes: minutes, updatedAt: nil)
    }

    private func reach(_ condition: @MainActor () -> Bool, line: UInt = #line) async {
        let reached = await eventually(condition)
        XCTAssertTrue(reached, line: line)
    }

    func testSignOutThenAnotherAccountShowsNoAlertsOrPreferencesOfTheFirst() async {
        let tracking = MockLiveRunSource()
        let notifications = ScriptedNotificationSource()
        let model = AlertsViewModel(tracking: tracking, notifications: notifications)

        // Account A: Alex's alert and preference, with a save still on its way.
        model.start()
        await reach { tracking.assignmentsContinuation != nil && notifications.inbox != nil }
        tracking.assignmentsContinuation?.yield(.ready([Self.alex]))
        notifications.inbox?.yield([PreviewFixtures.alert()])
        await reach { notifications.preferences["a_alex"] != nil }
        notifications.preferences["a_alex"]?.yield(Self.preference("a_alex", minutes: 5))
        await reach { model.preferences["a_alex"] != nil && !model.alerts.isEmpty }
        let saving = Task { await model.save(assignmentId: "a_alex", enabled: true, minutes: 7) }
        await reach { notifications.saveWaiting }

        // Sign out: A's subscriptions end and the model holds nothing of A.
        model.stop()
        XCTAssertEqual(model.state, .loading)
        XCTAssertTrue(model.assignments.isEmpty)
        XCTAssertTrue(model.alerts.isEmpty)
        XCTAssertTrue(model.preferences.isEmpty)
        XCTAssertTrue(model.saving.isEmpty)
        await reach { notifications.released.contains("alerts") && notifications.released.contains("a_alex") }

        // Account B signs in; A's save answers late.
        model.start()
        await reach { tracking.assignmentSubscriptionCount == 2 && notifications.inboxSubscriptions == 2 }
        tracking.assignmentsContinuation?.yield(.ready([Self.jordan]))
        await reach { notifications.preferences["a_jordan"] != nil }
        notifications.preferences["a_jordan"]?.yield(Self.preference("a_jordan", minutes: 10))
        notifications.inbox?.yield([])
        notifications.finishSave(Self.preference("a_alex", minutes: 7))
        await saving.value
        await reach { model.preferences["a_jordan"] != nil && model.state == .ready }
        XCTAssertEqual(model.assignments, [Self.jordan])
        XCTAssertEqual(Array(model.preferences.keys), ["a_jordan"])
        XCTAssertTrue(model.alerts.isEmpty)
        XCTAssertTrue(model.saving.isEmpty)
        XCTAssertTrue(model.saveFailed.isEmpty)
        model.stop()
    }
}
