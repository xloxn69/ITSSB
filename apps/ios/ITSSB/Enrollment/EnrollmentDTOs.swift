import ConvexMobile
import Foundation

// Wire types for enrollment, guardian links and check-in, contract version 1
// (docs/08 §9.1–§9.2, `packages/contracts/src/{enrollment,checkIns}.ts`).
// Numbers decode through Convex's float wrappers; `EnrollmentMapping`
// validates everything before it reaches the UI.

private enum StatusKey: String, CodingKey { case status }

private func wireStatus(_ decoder: Decoder) throws -> String {
    try decoder.container(keyedBy: StatusKey.self).decode(String.self, forKey: .status)
}

struct EligibleStopDTO: Decodable {
    let stopId: String
    let label: String
    @ConvexFloat var sequence: Double
    let instructions: String?
}

/// `enrollment:previewInvitation`.
struct PreviewInvitationDTO: Decodable {
    let status: String
    let routeLabel: String?
    let direction: String?
    let expiresAt: ConvexFloatBox?
    let stops: [EligibleStopDTO]?
    let problem: String?
    let reason: String?

    enum CodingKeys: String, CodingKey {
        case status, routeLabel, direction, stops, problem, reason
        case expiresAt = "expiresAtMs"
    }
}

/// An optional JavaScript number (Convex sends floats).
struct ConvexFloatBox: Decodable, Equatable {
    @ConvexFloat var value: Double

    init(from decoder: Decoder) throws {
        _value = try ConvexFloat(from: decoder)
    }
}

struct CheckInRecordDTO: Decodable {
    let checkInId: String
    let status: String
    let source: String
    @ConvexFloat var recordedAtMs: Double
    @ConvexFloat var receivedAtMs: Double
}

/// Any family command result: `enrollment:request`, `guardianLinks:request`, `checkIns:record`.
struct CommandResultDTO: Decodable {
    @ConvexFloat var schemaVersion: Double
    let status: String
    let requestStatus: String?
    let problem: String?
    let code: String?
    let message: String?
    let reason: String?
    let checkIn: CheckInRecordDTO?
}

struct MyEnrollmentRequestDTO: Decodable {
    let enrollmentRequestId: String
    let routeLabel: String
    let studentName: String
    let requestedStopLabel: String?
    let status: String
    @ConvexFloat var submittedAtMs: Double
    let decisionReason: String?
}

struct MyLinkRequestDTO: Decodable {
    let linkRequestId: String
    let status: String
    @ConvexFloat var submittedAtMs: Double
    let decisionReason: String?
    let studentDisplayName: String?
}

/// `enrollment:myRequests` and `guardianLinks:myRequests` share this envelope.
struct RequestListDTO<Item: Decodable>: Decodable {
    let status: String
    let requests: [Item]?
    let reason: String?
}

/// `checkIns:forAssignment`.
struct AssignmentCheckInDTO: Decodable {
    let status: String
    let runId: String?
    let checkIn: CheckInRecordDTO?
    let reason: String?
}

enum EnrollmentMapping {
    static func date(_ ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }

    static func access(_ reason: String?) -> EnrollmentAccessError {
        reason == "unauthenticated" ? .signedOut : .notPermitted
    }

    static func preview(_ dto: PreviewInvitationDTO) throws -> PreviewResult {
        switch dto.status {
        case "ready":
            guard let label = dto.routeLabel, let direction = dto.direction, let expires = dto.expiresAt,
                  let stops = dto.stops, direction == "to_school" || direction == "from_school"
            else { throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "incomplete preview")) }
            return .ready(InvitationPreview(
                routeLabel: label,
                towardSchool: direction == "to_school",
                expiresAt: date(expires.value),
                stops: stops.map {
                    EligibleStop(id: $0.stopId, label: $0.label, sequence: Int($0.sequence),
                                 instructions: $0.instructions)
                }.sorted { $0.sequence < $1.sequence }
            ))
        case "token_problem":
            return .problem(TokenProblem(rawValue: dto.problem ?? "") ?? .invalid)
        case "access_unavailable":
            return access(dto.reason) == .signedOut ? .signedOut : .notPermitted
        default:
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "unknown status \(dto.status)"))
        }
    }

    static func record(_ dto: CheckInRecordDTO) -> CheckInRecord? {
        guard let source = CheckInSource(rawValue: dto.source),
              dto.status == "boarded" || dto.status == "not_boarded" else { return nil }
        return CheckInRecord(id: dto.checkInId, boarded: dto.status == "boarded", source: source,
                             recordedAt: date(dto.recordedAtMs))
    }

    /// What a command answer means. Anything unreadable is `.unconfirmed`, never `.sent`.
    static func outcome(_ dto: CommandResultDTO) -> CommandOutcome {
        guard dto.schemaVersion == 1 else { return .unconfirmed }
        switch dto.status {
        case "submitted":
            return .sent
        case "accepted", "already_recorded":
            guard let checkIn = dto.checkIn, let record = record(checkIn) else { return .unconfirmed }
            return .recorded(record, alreadyRecorded: dto.status == "already_recorded")
        case "token_problem":
            guard let problem = TokenProblem(rawValue: dto.problem ?? "") else { return .unconfirmed }
            return .problem(problem)
        case "refused", "rejected":
            return .refused(code: dto.code ?? "unknown",
                            message: dto.message ?? "The school's system didn't accept this.")
        case "access_unavailable":
            return access(dto.reason) == .signedOut ? .signedOut : .notPermitted
        default:
            return .unconfirmed
        }
    }

    static func requests(enrollment: RequestListDTO<MyEnrollmentRequestDTO>,
                         links: RequestListDTO<MyLinkRequestDTO>) throws -> RequestsSnapshot {
        RequestsSnapshot(enrollment: try enrollmentItems(enrollment), links: try linkItems(links))
    }

    static func enrollmentItems(_ dto: RequestListDTO<MyEnrollmentRequestDTO>) throws -> [EnrollmentRequestItem] {
        guard dto.status == "ready", let rows = dto.requests else { throw access(dto.reason) }
        return rows.compactMap { row in
            RequestStatus(rawValue: row.status).map {
                EnrollmentRequestItem(id: row.enrollmentRequestId, studentName: row.studentName,
                                      routeLabel: row.routeLabel, requestedStopLabel: row.requestedStopLabel,
                                      status: $0, submittedAt: date(row.submittedAtMs),
                                      decisionReason: row.decisionReason)
            }
        }
    }

    static func linkItems(_ dto: RequestListDTO<MyLinkRequestDTO>) throws -> [LinkRequestItem] {
        guard dto.status == "ready", let rows = dto.requests else { throw access(dto.reason) }
        return rows.compactMap { row in
            RequestStatus(rawValue: row.status).map {
                LinkRequestItem(id: row.linkRequestId, status: $0, submittedAt: date(row.submittedAtMs),
                                studentDisplayName: row.studentDisplayName, decisionReason: row.decisionReason)
            }
        }
    }

    static func tripCheckIn(_ dto: AssignmentCheckInDTO) throws -> TripCheckIn {
        guard dto.status == "ready" else { throw access(dto.reason) }
        return TripCheckIn(runId: dto.runId, record: dto.checkIn.flatMap(record))
    }

    static func ownAssignments(_ dto: MyAssignmentsDTO) throws -> [OwnAssignment] {
        switch dto {
        case .ready(let ready):
            return ready.assignments.filter { $0.relationship == "self" }
                .map { OwnAssignment(id: $0.assignmentId, routeLabel: $0.routeLabel) }
        case .accessUnavailable(let denied):
            throw access(denied.reason)
        }
    }
}
