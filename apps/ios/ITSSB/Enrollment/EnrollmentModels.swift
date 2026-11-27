import Foundation

// Domain values for enrollment, guardian links and check-in (docs/09).
// Only values the server actually returned become `.sent` or `.recorded`;
// anything else is `.unconfirmed`.

enum TokenProblem: String, Sendable, Equatable {
    case invalid
    case expired
    case wrongPurpose = "wrong_purpose"
    case alreadyUsed = "already_used"
    case unavailable

    var title: String {
        switch self {
        case .invalid: "That code didn't work"
        case .expired: "This code has expired"
        case .wrongPurpose: "That's a different kind of code"
        case .alreadyUsed: "This code was already used"
        case .unavailable: "This route isn't open yet"
        }
    }

    var detail: String {
        switch self {
        case .invalid: "Check the code and try again, or scan it again."
        case .expired: "Ask for a new code, or scan the one on the bus again."
        case .wrongPurpose: "This code is for something else. Use the code meant for this step."
        case .alreadyUsed: "Guardian codes work once. Ask the school for a new one."
        case .unavailable: "The school hasn't approved this route yet. Try again later."
        }
    }
}

struct EligibleStop: Sendable, Equatable, Identifiable {
    let id: String
    let label: String
    let sequence: Int
    let instructions: String?
}

struct InvitationPreview: Sendable, Equatable {
    let routeLabel: String
    let towardSchool: Bool
    let expiresAt: Date
    let stops: [EligibleStop]
}

enum PreviewResult: Sendable, Equatable {
    case ready(InvitationPreview)
    case problem(TokenProblem)
    case signedOut
    case notPermitted
}

enum CheckInSource: String, Sendable, Equatable {
    case studentQrClaim = "student_qr_claim"
    case staffRecorded = "staff_recorded"
    case staffCorrection = "staff_correction"

    /// Plain words for where the record came from. A scan is a claim, not proof of boarding.
    var familyText: String {
        switch self {
        case .studentQrClaim: "your scan"
        case .staffRecorded: "recorded by staff"
        case .staffCorrection: "corrected by staff"
        }
    }
}

struct CheckInRecord: Sendable, Equatable {
    let id: String
    let boarded: Bool
    let source: CheckInSource
    let recordedAt: Date
}

enum CommandOutcome: Sendable, Equatable {
    /// The server has the request (`submitted`).
    case sent
    /// A check-in the server recorded now, or had already recorded.
    case recorded(CheckInRecord, alreadyRecorded: Bool)
    case problem(TokenProblem)
    case refused(code: String, message: String)
    case signedOut
    case notPermitted
    /// No readable answer: the request may or may not have arrived. Retry with the same requestId.
    case unconfirmed
}

enum RequestStatus: String, Sendable, Equatable {
    case pending, approved, rejected

    var text: String {
        switch self {
        case .pending: "Waiting for the school"
        case .approved: "Approved"
        case .rejected: "Not approved"
        }
    }
}

struct EnrollmentRequestItem: Sendable, Equatable, Identifiable {
    let id: String
    let studentName: String
    let routeLabel: String
    let requestedStopLabel: String?
    let status: RequestStatus
    let submittedAt: Date
    let decisionReason: String?
}

struct LinkRequestItem: Sendable, Equatable, Identifiable {
    let id: String
    let status: RequestStatus
    let submittedAt: Date
    let studentDisplayName: String?
    let decisionReason: String?
}

struct RequestsSnapshot: Sendable, Equatable {
    let enrollment: [EnrollmentRequestItem]
    let links: [LinkRequestItem]
}

/// One of the signed-in student's own approved assignments.
struct OwnAssignment: Sendable, Equatable, Identifiable {
    let id: String
    let routeLabel: String
}

/// The active run on an assignment's route and its current record.
struct TripCheckIn: Sendable, Equatable {
    let runId: String?
    let record: CheckInRecord?
}

struct EnrollmentRequestInput: Sendable, Equatable {
    let requestId: String
    let token: String
    let studentName: String
    let address: String
    /// nil asks the school to choose (manual review).
    let stopId: String?
    let note: String?
}

enum EnrollmentAccessError: Error, Equatable {
    case signedOut
    case notPermitted
}
