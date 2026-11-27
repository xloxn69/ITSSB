import XCTest
@testable import ITSSB

/// Decodes the shared enrollment and check-in fixtures, and checks the rules
/// the screens rely on: nothing shows as sent unless the server said so, a
/// retry reuses its request identity, and a scan is a claim, not proof.
final class EnrollmentDecodingTests: XCTestCase {
    func testPreviewDecodesStopsInOrder() throws {
        let dto = try ContractFixture.decode(PreviewInvitationDTO.self, "enrollment.preview.ready")
        let result = try EnrollmentMapping.preview(dto)
        guard case let .ready(preview) = result else { return XCTFail("expected ready") }
        XCTAssertEqual(preview.routeLabel, "Route 17 Morning")
        XCTAssertTrue(preview.towardSchool)
        XCTAssertEqual(preview.stops.map(\.label), ["Oak & Pine", "Maple Court"])
        XCTAssertEqual(preview.expiresAt.timeIntervalSince1970, 1_795_694_400, accuracy: 0.001)
    }

    func testExpiredPreviewIsATokenProblem() throws {
        let dto = try ContractFixture.decode(PreviewInvitationDTO.self, "enrollment.preview.expired")
        let result = try EnrollmentMapping.preview(dto)
        XCTAssertEqual(result, .problem(.expired))
    }

    func testCommandResults() throws {
        func outcome(_ name: String) throws -> CommandOutcome {
            EnrollmentMapping.outcome(try ContractFixture.decode(CommandResultDTO.self, name))
        }
        XCTAssertEqual(try outcome("enrollment.request.submitted"), .sent)
        XCTAssertEqual(try outcome("guardianLinks.request.submitted"), .sent)
        guard case .refused(code: "stop_not_eligible", _) = try outcome("enrollment.request.refused") else {
            return XCTFail("expected refused")
        }
        XCTAssertEqual(try outcome("checkIns.record.expired"), .problem(.expired))
        guard case let .recorded(record, alreadyRecorded: false) = try outcome("checkIns.record.accepted") else {
            return XCTFail("expected accepted")
        }
        XCTAssertEqual(record.source, .studentQrClaim)
        XCTAssertTrue(record.boarded)
        guard case .recorded(_, alreadyRecorded: true) = try outcome("checkIns.record.alreadyRecorded") else {
            return XCTFail("expected already recorded")
        }
        guard case .refused(code: "run_not_active", _) = try outcome("checkIns.record.rejected") else {
            return XCTFail("expected rejected")
        }
    }

    func testAnUnreadableAnswerIsUnconfirmedNotSent() throws {
        for json in [#"{"schemaVersion":1,"status":"something_new"}"#,
                     #"{"schemaVersion":1,"status":"accepted"}"#,
                     #"{"schemaVersion":2,"status":"submitted"}"#] {
            let dto = try JSONDecoder().decode(CommandResultDTO.self, from: Data(json.utf8))
            XCTAssertEqual(EnrollmentMapping.outcome(dto), .unconfirmed, json)
        }
    }

    func testRequestListsDecode() throws {
        let snapshot = try EnrollmentMapping.requests(
            enrollment: ContractFixture.decode(RequestListDTO<MyEnrollmentRequestDTO>.self,
                                               "enrollment.myRequests.ready"),
            links: ContractFixture.decode(RequestListDTO<MyLinkRequestDTO>.self, "guardianLinks.myRequests.ready"))
        XCTAssertEqual(snapshot.enrollment.map(\.status), [.pending, .rejected])
        XCTAssertEqual(snapshot.enrollment[1].decisionReason, "Outside the service area")
        XCTAssertNil(snapshot.links[0].studentDisplayName, "a pending link reveals no student")
        XCTAssertEqual(snapshot.links[1].studentDisplayName, "Sam Example")
    }

    func testTripCheckInDecodes() throws {
        let dto = try ContractFixture.decode(AssignmentCheckInDTO.self, "checkIns.forAssignment.ready")
        let trip = try EnrollmentMapping.tripCheckIn(dto)
        XCTAssertEqual(trip.runId, "demo_run_001")
        XCTAssertEqual(trip.record?.source, .studentQrClaim)
    }

    func testSourceWordsNeverClaimVerification() {
        for source in [CheckInSource.studentQrClaim, .staffRecorded, .staffCorrection] {
            XCTAssertFalse(source.familyText.lowercased().contains("verified"))
        }
    }
}

final class ScopedTokenTests: XCTestCase {
    private let hosts: Set<String> = ["example.invalid"]

    func testNormalizes() {
        XCTAssertEqual(ScopedToken.normalize(" abcd-efgh jkmn-pqrs-tvwx "), "ABCDEFGHJKMNPQRSTVWX")
        XCTAssertEqual(ScopedToken.format("ABCDEFGHJKMNPQRSTVWX"), "ABCD-EFGH-JKMN-PQRS-TVWX")
        let tooLong = String(repeating: "x", count: 65)
        for bad in ["", "ABCD", "ABCDEFGHJKMNPQRSTVWXY", "ILOU-ILOU-ILOU-ILOU-ILOU", tooLong] {
            XCTAssertNil(ScopedToken.normalize(bad), bad)
        }
    }

    func testLinksOnlyOnTheAllowedHostAndPath() {
        let code = "ABCD-EFGH-JKMN-PQRS-TVWX"
        XCTAssertEqual(ScopedToken.parse("https://example.invalid/join?token=\(code)", purpose: .routeEnrollment,
                                         allowedHosts: hosts), "ABCDEFGHJKMNPQRSTVWX")
        for bad in ["http://example.invalid/join?token=\(code)", "https://evil.example/join?token=\(code)",
                    "https://example.invalid/checkin?token=\(code)", "https://example.invalid/join?token=\(code)&x=1",
                    "https://example.invalid/join?token=\(code)#x",
                    "https://example.invalid.evil.example/join?token=\(code)"] {
            XCTAssertNil(ScopedToken.parse(bad, purpose: .routeEnrollment, allowedHosts: hosts), bad)
        }
    }
}

/// Records every command and answers from a script.
private final class ScriptedSource: EnrollmentSource, @unchecked Sendable {
    private let lock = NSLock()
    private var answers: [Result<CommandOutcome, Error>]
    private(set) var sentRequestIds: [String] = []

    init(_ answers: [Result<CommandOutcome, Error>]) { self.answers = answers }

    private func next(_ requestId: String) throws -> CommandOutcome {
        try lock.withLock {
            sentRequestIds.append(requestId)
            return try answers.removeFirst().get()
        }
    }

    func preview(token: String) async throws -> PreviewResult {
        .ready(InvitationPreview(routeLabel: "Route 17 Morning", towardSchool: true, expiresAt: .distantFuture,
                                 stops: [EligibleStop(id: "s1", label: "Oak & Pine", sequence: 0, instructions: nil)]))
    }
    func requestEnrollment(_ input: EnrollmentRequestInput) async throws -> CommandOutcome { try next(input.requestId) }
    func requestLink(requestId: String, token: String, guardianName: String) async throws -> CommandOutcome {
        try next(requestId)
    }
    func requests() -> AsyncThrowingStream<RequestsSnapshot, Error> { AsyncThrowingStream { $0.finish() } }
    func ownAssignments() -> AsyncThrowingStream<[OwnAssignment], Error> { AsyncThrowingStream { $0.finish() } }
    func tripCheckIn(assignmentId: String) -> AsyncThrowingStream<TripCheckIn, Error> {
        AsyncThrowingStream { $0.yield(TripCheckIn(runId: "run1", record: nil)); $0.finish() }
    }
    func recordCheckIn(requestId: String, token: String, runId: String) async throws -> CommandOutcome {
        try next(requestId)
    }
}

@MainActor
final class EnrollmentViewModelTests: XCTestCase {
    func testALostAnswerIsUnconfirmedAndTheRetryReusesTheRequestId() async {
        let record = CheckInRecord(id: "c1", boarded: true, source: .studentQrClaim, recordedAt: .now)
        let source = ScriptedSource([.failure(URLError(.timedOut)), .success(.sent)])
        let model = JoinRouteViewModel(source: source, initialCode: "ABCD-EFGH-JKMN-PQRS-TVWX", requestId: "req-1")
        await model.checkCode()
        model.studentName = "Alex Fictional"
        model.address = "12 Fictional Lane"
        model.stop = .stop("s1")
        await model.send()
        XCTAssertEqual(model.outcome, .unconfirmed, "a lost answer is never shown as sent")
        await model.send()
        XCTAssertEqual(model.outcome, .sent)
        XCTAssertEqual(source.sentRequestIds, ["req-1", "req-1"])
        _ = record
    }

    func testCannotSendWithoutAStopChoice() async {
        let source = ScriptedSource([])
        let model = JoinRouteViewModel(source: source, initialCode: "ABCD-EFGH-JKMN-PQRS-TVWX")
        await model.checkCode()
        model.studentName = "Alex Fictional"
        model.address = "12 Fictional Lane"
        XCTAssertFalse(model.canSend)
        model.stop = .schoolChooses
        XCTAssertTrue(model.canSend)
    }

    func testCheckInRetryKeepsItsIdentityAndShowsTheServersRecord() async {
        let record = CheckInRecord(id: "c1", boarded: true, source: .studentQrClaim, recordedAt: .now)
        let source = ScriptedSource([.failure(URLError(.networkConnectionLost)),
                                     .success(.recorded(record, alreadyRecorded: true))])
        let model = CheckInViewModel(source: source, assignment: OwnAssignment(id: "a1", routeLabel: "Route 17"),
                                     requestId: "scan-1")
        await model.watch()
        await model.submit(scanned: "AAAA-BBBB-CCCC-DDDD-EEEE")
        XCTAssertEqual(model.outcome, .unconfirmed)
        XCTAssertNil(model.record)
        await model.submit(scanned: "AAAA-BBBB-CCCC-DDDD-EEEE")
        XCTAssertEqual(model.record, record)
        XCTAssertEqual(source.sentRequestIds, ["scan-1", "scan-1"])
    }

    func testAGarbageScanSendsNothing() async {
        let source = ScriptedSource([])
        let model = CheckInViewModel(source: source, assignment: OwnAssignment(id: "a1", routeLabel: "Route 17"))
        await model.watch()
        await model.submit(scanned: "https://evil.example/checkin?token=AAAABBBBCCCCDDDDEEEE")
        XCTAssertEqual(model.outcome, .problem(.invalid))
        XCTAssertTrue(source.sentRequestIds.isEmpty)
    }
}
