import Foundation
import Observation

/// Allowed hosts for scanned links. The real domain is a deployment decision
/// (docs/08 §9); until it exists, typed codes and the documentation host work.
enum EnrollmentLinks {
    static let allowedHosts: Set<String> = ["example.invalid"]
}

/// I05 → I06 → I07/I08: enter a route code, review the route, send the private request once.
@MainActor @Observable
final class JoinRouteViewModel {
    enum Phase: Equatable {
        case enterCode
        case checking
        case problem(TokenProblem)
        case signedOut
        case failed
        case form(token: String, preview: InvitationPreview)
    }

    enum StopChoice: Equatable {
        case stop(String)
        case schoolChooses
    }

    var codeText = ""
    var studentName = ""
    var address = ""
    var note = ""
    var stop: StopChoice?
    private(set) var phase: Phase = .enterCode
    private(set) var sending = false
    private(set) var outcome: CommandOutcome?

    /// One identity for this request, reused by every resend: a double tap
    /// or a retry after a lost answer never makes a second request.
    let requestId: String
    private let source: any EnrollmentSource

    init(source: any EnrollmentSource, initialCode: String = "", requestId: String = UUID().uuidString) {
        self.source = source
        self.codeText = initialCode
        self.requestId = requestId
    }

    var parsedCode: String? {
        ScopedToken.parse(codeText, purpose: .routeEnrollment, allowedHosts: EnrollmentLinks.allowedHosts)
    }

    var canSend: Bool {
        guard case .form = phase, !sending else { return false }
        return !studentName.trimmed.isEmpty && !address.trimmed.isEmpty && stop != nil
    }

    func checkCode() async {
        guard let token = parsedCode else { phase = .problem(.invalid); return }
        phase = .checking
        do {
            switch try await source.preview(token: token) {
            case .ready(let preview): phase = .form(token: token, preview: preview)
            case .problem(let problem): phase = .problem(problem)
            case .signedOut, .notPermitted: phase = .signedOut
            }
        } catch {
            phase = .failed
        }
    }

    func send() async {
        guard case let .form(token, _) = phase, canSend, let stop else { return }
        sending = true
        defer { sending = false }
        let stopId: String? = if case let .stop(id) = stop { id } else { nil }
        do {
            outcome = try await source.requestEnrollment(EnrollmentRequestInput(
                requestId: requestId, token: token, studentName: studentName.trimmed, address: address.trimmed,
                stopId: stopId, note: note.trimmed.isEmpty ? nil : note.trimmed))
        } catch {
            outcome = .unconfirmed
        }
    }

    /// Editing clears an old refusal. The identity stays: refused requests
    /// aren't stored, and an unconfirmed one must be resent unchanged.
    func edited() {
        if let outcome, outcome != .unconfirmed { self.outcome = nil }
    }
}

/// Link a student with a school-issued, single-use guardian code.
@MainActor @Observable
final class LinkStudentViewModel {
    var codeText = ""
    var guardianName = ""
    private(set) var sending = false
    private(set) var outcome: CommandOutcome?
    let requestId: String
    private let source: any EnrollmentSource

    init(source: any EnrollmentSource, initialCode: String = "", requestId: String = UUID().uuidString) {
        self.source = source
        self.codeText = initialCode
        self.requestId = requestId
    }

    var parsedCode: String? {
        ScopedToken.parse(codeText, purpose: .guardianLink, allowedHosts: EnrollmentLinks.allowedHosts)
    }

    var canSend: Bool { parsedCode != nil && !guardianName.trimmed.isEmpty && !sending && outcome != .sent }

    func send() async {
        guard canSend, let token = parsedCode else { return }
        sending = true
        defer { sending = false }
        do {
            outcome = try await source.requestLink(requestId: requestId, token: token,
                                                   guardianName: guardianName.trimmed)
        } catch {
            outcome = .unconfirmed
        }
    }
}

/// I17 → I18 for one of the student's own assignments.
@MainActor @Observable
final class CheckInViewModel {
    enum TripState: Equatable {
        case loading
        case failed
        case ready(TripCheckIn)
    }

    var codeText = ""
    private(set) var trip: TripState = .loading
    private(set) var sending = false
    private(set) var outcome: CommandOutcome?
    let requestId: String
    let assignment: OwnAssignment
    private let source: any EnrollmentSource

    init(source: any EnrollmentSource, assignment: OwnAssignment, requestId: String = UUID().uuidString) {
        self.source = source
        self.assignment = assignment
        self.requestId = requestId
    }

    /// The record to show: the server's answer to this scan, else the stored one.
    var record: CheckInRecord? {
        if case let .recorded(record, _) = outcome { return record }
        if case let .ready(trip) = trip { return trip.record }
        return nil
    }

    func watch() async {
        do {
            for try await value in source.tripCheckIn(assignmentId: assignment.id) { trip = .ready(value) }
        } catch {
            trip = .failed
        }
    }

    /// Sends one scan. Ignored while a scan is in flight, so repeated camera
    /// frames can't send repeated check-ins.
    func submit(scanned text: String) async {
        guard !sending, case let .ready(current) = trip, let runId = current.runId,
              let token = ScopedToken.parse(text, purpose: .tripCheckIn, allowedHosts: EnrollmentLinks.allowedHosts)
        else {
            if !sending { outcome = .problem(.invalid) }
            return
        }
        sending = true
        defer { sending = false }
        do {
            outcome = try await source.recordCheckIn(requestId: requestId, token: token, runId: runId)
        } catch {
            outcome = .unconfirmed
        }
    }
}

/// Lists the account's own enrollment and guardian requests.
@MainActor @Observable
final class RequestsViewModel {
    enum State: Equatable {
        case loading
        case failed
        case signedOut
        case ready(RequestsSnapshot)
    }

    private(set) var state: State = .loading
    private let source: any EnrollmentSource

    init(source: any EnrollmentSource) {
        self.source = source
    }

    func watch() async {
        do {
            for try await value in source.requests() { state = .ready(value) }
        } catch let error as EnrollmentAccessError {
            state = error == .signedOut ? .signedOut : .failed
        } catch {
            state = .failed
        }
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
