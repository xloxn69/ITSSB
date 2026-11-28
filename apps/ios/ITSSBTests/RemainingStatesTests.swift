import XCTest
@testable import ITSSB

/// Answers check-ins only when released, and counts every call. No network.
private final class GatedEnrollmentSource: EnrollmentSource, @unchecked Sendable {
    private let lock = NSLock()
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private var released = false
    private var answers: [CommandOutcome]
    private(set) var sentRequestIds: [String] = []
    private(set) var sentStopIds: [String?] = []

    init(answers: [CommandOutcome] = []) { self.answers = answers }

    var callCount: Int { lock.withLock { sentRequestIds.count } }

    func release() {
        let pending = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
            released = true
            defer { waiting = [] }
            return waiting
        }
        pending.forEach { $0.resume() }
    }

    private func gate() async {
        await withCheckedContinuation { continuation in
            let now = lock.withLock { () -> Bool in
                if released { return true }
                waiting.append(continuation)
                return false
            }
            if now { continuation.resume() }
        }
    }

    private func answer(_ requestId: String, stopId: String?? = nil) -> CommandOutcome {
        lock.withLock {
            sentRequestIds.append(requestId)
            if let stopId { sentStopIds.append(stopId) }
            return answers.isEmpty ? .sent : answers.removeFirst()
        }
    }

    func preview(token: String) async throws -> PreviewResult {
        .ready(InvitationPreview(routeLabel: "Route 17 Morning", towardSchool: true, expiresAt: .distantFuture,
                                 stops: [EligibleStop(id: "s1", label: "Oak & Pine", sequence: 0, instructions: nil)]))
    }
    func requestEnrollment(_ input: EnrollmentRequestInput) async throws -> CommandOutcome {
        answer(input.requestId, stopId: .some(input.stopId))
    }
    func requestLink(requestId: String, token: String, guardianName: String) async throws -> CommandOutcome {
        answer(requestId)
    }
    func requests() -> AsyncThrowingStream<RequestsSnapshot, Error> { AsyncThrowingStream { $0.finish() } }
    func ownAssignments() -> AsyncThrowingStream<[OwnAssignment], Error> { AsyncThrowingStream { $0.finish() } }
    func tripCheckIn(assignmentId: String) -> AsyncThrowingStream<TripCheckIn, Error> {
        AsyncThrowingStream { $0.yield(TripCheckIn(runId: "run1", record: nil)); $0.finish() }
    }
    func recordCheckIn(requestId: String, token: String, runId: String) async throws -> CommandOutcome {
        let outcome = answer(requestId)
        await gate()
        return outcome
    }
}

@MainActor
final class RemainingStatesTests: XCTestCase {
    // MARK: A07 recovery after stop_not_eligible

    func testStopRefusalRecoversByEditingAndResendingWithTheSameIdentity() async {
        let source = GatedEnrollmentSource(answers: [
            .refused(code: "stop_not_eligible", message: "That stop isn't one of this route's approved stops."),
            .sent
        ])
        let model = JoinRouteViewModel(source: source, initialCode: "ABCD-EFGH-JKMN-PQRS-TVWX", requestId: "req-7")
        await model.checkCode()
        model.studentName = "Alex Fictional"
        model.address = "12 Fictional Lane"
        model.stop = .stop("s_retired")
        await model.send()
        XCTAssertEqual(model.outcome, .refused(code: "stop_not_eligible",
                                               message: "That stop isn't one of this route's approved stops."))

        model.stop = .schoolChooses
        model.edited()
        XCTAssertNil(model.outcome, "editing clears the refusal")
        XCTAssertTrue(model.canSend)
        await model.send()
        XCTAssertEqual(model.outcome, .sent)
        XCTAssertEqual(source.sentRequestIds, ["req-7", "req-7"], "a refused request isn't stored, so it is reused")
        XCTAssertEqual(source.sentStopIds, ["s_retired", nil], "\"school chooses\" sends no stop")
    }

    func testAnUnconfirmedAnswerSurvivesEditingSoTheResendStaysUnchanged() async {
        let source = GatedEnrollmentSource(answers: [.unconfirmed])
        let model = JoinRouteViewModel(source: source, initialCode: "ABCD-EFGH-JKMN-PQRS-TVWX")
        await model.checkCode()
        model.studentName = "Alex Fictional"
        model.address = "12 Fictional Lane"
        model.stop = .stop("s1")
        await model.send()
        model.edited()
        XCTAssertEqual(model.outcome, .unconfirmed)
    }

    // MARK: Concurrent check-in

    func testTwoConcurrentCheckInSubmitsSendOnce() async {
        let source = GatedEnrollmentSource()
        let model = CheckInViewModel(source: source, assignment: OwnAssignment(id: "a1", routeLabel: "Route 17"),
                                     requestId: "scan-1")
        await model.watch()
        let first = Task { await model.submit(scanned: "AAAA-BBBB-CCCC-DDDD-EEEE") }
        let second = Task { await model.submit(scanned: "AAAA-BBBB-CCCC-DDDD-EEEE") }
        _ = await eventually { source.callCount >= 1 }
        source.release()
        await first.value
        await second.value
        XCTAssertEqual(source.callCount, 1, "a second tap or frame while the first is in flight sends nothing")
    }

    // MARK: Notification tap after the run completed

    func testNotificationTapAfterTheRunCompletedShowsNoTripNotALiveView() async {
        let source = MockLiveRunSource()
        let alex = AssignmentSummary(assignmentId: "a_alex", relationship: .guardian,
                                     studentDisplayName: "Alex Example", routeLabel: "Route 17", stopLabel: "Oak")
        let model = TrackViewModel(source: source)
        model.start()
        _ = await eventually { source.assignmentsContinuation != nil }
        source.assignmentsContinuation?.yield(.ready([alex]))
        _ = await eventually { source.runContinuation("a_alex") != nil }
        let live = TrackedRun(runId: "run_1", state: .active, liveRevision: 3, busLabel: "Bus 12",
                              lastDeviceContactAt: nil, gpsStatus: .valid,
                              position: PreviewFixtures.position(capturedSecondsAgo: 2),
                              assignedStop: PreviewFixtures.stop)
        source.runContinuation("a_alex")?.yield(.ready(assignmentId: "a_alex", routeVersionId: "rv_1", run: live,
                                                       clock: .deviceOnly, notices: .none))
        let tracking = await eventually { if case .tracking = model.state { true } else { false } }
        XCTAssertTrue(tracking)

        // The run completes; then the person taps the alert for it.
        let completed = TripNotices(endedRun: EndedRun(runId: "run_1", state: .completed, serviceDate: "2026-11-28",
                                                       endedAt: nil, replacementPending: false,
                                                       validUntil: .distantFuture),
                                    serviceNotice: nil)
        source.runContinuation("a_alex")?.yield(.noActiveRun(assignmentId: "a_alex", routeVersionId: "rv_1",
                                                             clock: .deviceOnly, notices: completed))
        model.open(assignmentId: "a_alex")
        let ended = await eventually {
            if case let .noActiveRun(context, _) = model.state { return context.notices.endedRun?.state == .completed }
            return false
        }
        XCTAssertTrue(ended, "the tap shows the completed trip, with no live bus")
        model.stop()
    }

    // MARK: I10 Guardian dashboard

    func testDashboardRowsAreHonestAboutAge() {
        let now = Date()
        func run(_ secondsAgo: TimeInterval?) -> RunSnapshot {
            .ready(assignmentId: "a", routeVersionId: "rv", run: PreviewFixtures.run(
                position: secondsAgo.map { PreviewFixtures.position(capturedSecondsAgo: $0, now: now) }),
                   clock: .deviceOnly, notices: .none)
        }
        XCTAssertEqual(DashboardRow.make(snapshot: nil, failed: false, now: now).status, "Checking…")
        XCTAssertEqual(DashboardRow.make(snapshot: nil, failed: true, now: now).status, "Couldn't load this trip")
        XCTAssertEqual(DashboardRow.make(snapshot: .noActiveRun(assignmentId: "a", routeVersionId: "rv",
                                         clock: .deviceOnly, notices: .none),
                                         failed: false, now: now).status, "No trip right now")
        XCTAssertEqual(DashboardRow.make(snapshot: run(nil), failed: false, now: now).detail,
                       "Waiting for the bus's location")
        XCTAssertEqual(DashboardRow.make(snapshot: run(5), failed: false, now: now).tone, .fresh)
        let stale = DashboardRow.make(snapshot: run(300), failed: false, now: now)
        XCTAssertEqual(stale.tone, .stale)
        XCTAssertEqual(stale.status, "Last known location", "an old position is never called a running trip's live one")
    }

    func testDashboardKeepsEachStudentsOwnTripAndDropsRemovedOnes() async {
        let source = MockLiveRunSource()
        let model = GuardianDashboardModel(source: source)
        model.update(assignmentIds: ["a_alex", "a_jordan"])
        _ = await eventually { source.runContinuation("a_alex") != nil && source.runContinuation("a_jordan") != nil }
        source.runContinuation("a_jordan")?.yield(.noActiveRun(assignmentId: "a_jordan", routeVersionId: "rv",
                                         clock: .deviceOnly, notices: .none))
        // A misrouted answer for another assignment is never shown on this row.
        source.runContinuation("a_alex")?.yield(.noActiveRun(assignmentId: "a_jordan", routeVersionId: "rv",
                                         clock: .deviceOnly, notices: .none))
        let jordan = await eventually { model.snapshots["a_jordan"] != nil }
        XCTAssertTrue(jordan)
        XCTAssertNil(model.snapshots["a_alex"])

        model.update(assignmentIds: ["a_alex"])
        XCTAssertNil(model.snapshots["a_jordan"], "a removed student's trip is forgotten")
        let cancelled = await eventually { source.cancelledRuns.contains("a_jordan") }
        XCTAssertTrue(cancelled)
        model.stop()
    }

    // MARK: I12/I16 check-in from the trip

    func testOnlyAStudentOnARunningTripIsOfferedCheckIn() {
        let atStop = PreviewFixtures.run(position: nil, stopStatus: .atStop)
        XCTAssertEqual(CheckInEntry.make(relationship: .self, run: atStop), .atStop)
        XCTAssertEqual(CheckInEntry.make(relationship: .self, run: PreviewFixtures.run(position: nil)), .available)
        XCTAssertEqual(CheckInEntry.make(relationship: .guardian, run: atStop), .none,
                       "a guardian never checks a student in")
        XCTAssertEqual(CheckInEntry.make(relationship: .self,
                                         run: PreviewFixtures.run(state: .completed, position: nil)), .none)
    }

    // MARK: I04 Profile, I20 unread

    private func freshDefaults() -> UserDefaults {
        let name = "itssb.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        addTeardownBlock { defaults.removePersistentDomain(forName: name) }
        return defaults
    }

    func testProfileStaysWithItsAccountAndClearsOnSignOut() {
        let defaults = freshDefaults()
        let sam = ProfileStore(account: "sam.example@example.com", defaults: defaults)
        sam.name = "Sam Example"
        sam.role = .student
        XCTAssertEqual(ProfileStore(account: "sam.example@example.com", defaults: defaults).role, .student)
        let other = ProfileStore(account: "riley.example@example.com", defaults: defaults)
        XCTAssertEqual(other.name, "", "another account on this phone sees nothing")
        XCTAssertNil(other.role)
        XCTAssertFalse(defaults.dictionaryRepresentation().keys.contains { $0.contains("example.com") },
                       "the sign-in label isn't stored")
        sam.clear()
        XCTAssertNil(ProfileStore(account: "sam.example@example.com", defaults: defaults).role)
    }

    func testReadMarksPersistAndStayBounded() {
        let defaults = freshDefaults()
        let marks = AlertReadMarks(defaults: defaults)
        XCTAssertFalse(marks.isRead("al_1"))
        marks.markRead("al_1")
        XCTAssertTrue(AlertReadMarks(defaults: defaults).isRead("al_1"))
        for index in 0..<AlertReadMarks.limit { marks.markRead("al_x\(index)") }
        XCTAssertEqual(marks.readIds.count, AlertReadMarks.limit)
        XCTAssertFalse(marks.isRead("al_1"), "the oldest mark is dropped first")
        marks.clear()
        XCTAssertFalse(AlertReadMarks(defaults: defaults).isRead("al_x5"))
    }
}
