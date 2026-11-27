#if DEBUG
import Foundation

/// Fictional enrollment answers for previews and screenshots only.
struct PreviewEnrollmentSource: EnrollmentSource {
    enum Variant: String, Sendable { case normal, offline, guardian, noTrip, recorded, empty }
    var variant: Variant = .normal

    static let stops = [
        EligibleStop(id: "demo_stop_001", label: "Oak & Pine", sequence: 0, instructions: "North corner"),
        EligibleStop(id: "demo_stop_002", label: "Maple Court", sequence: 1, instructions: nil)
    ]

    func preview(token: String) async throws -> PreviewResult {
        if token.hasPrefix("EXP") { return .problem(.expired) }
        if token.hasPrefix("GRD") { return .problem(.wrongPurpose) }
        return .ready(InvitationPreview(routeLabel: "Route 17 Morning", towardSchool: true,
                                        expiresAt: Date().addingTimeInterval(3 * 86_400), stops: Self.stops))
    }

    func requestEnrollment(_ input: EnrollmentRequestInput) async throws -> CommandOutcome {
        if variant == .offline { throw URLError(.notConnectedToInternet) }
        if input.studentName.lowercased().contains("refuse") {
            return .refused(code: "already_requested",
                            message: "A request for this route is already waiting for the school.")
        }
        return .sent
    }

    func requestLink(requestId: String, token: String, guardianName: String) async throws -> CommandOutcome {
        if variant == .offline { throw URLError(.notConnectedToInternet) }
        return .sent
    }

    func requests() -> AsyncThrowingStream<RequestsSnapshot, Error> {
        let now = Date()
        let snapshot = variant == .empty ? RequestsSnapshot(enrollment: [], links: []) : RequestsSnapshot(
            enrollment: [
                EnrollmentRequestItem(id: "r1", studentName: "Alex Fictional", routeLabel: "Route 17 Morning",
                                      requestedStopLabel: "Oak & Pine", status: .pending,
                                      submittedAt: now.addingTimeInterval(-1_800), decisionReason: nil),
                EnrollmentRequestItem(id: "r2", studentName: "Alex Fictional", routeLabel: "Route 4 Afternoon",
                                      requestedStopLabel: nil, status: .rejected,
                                      submittedAt: now.addingTimeInterval(-90_000),
                                      decisionReason: "Outside the service area")
            ],
            links: [
                LinkRequestItem(id: "l1", status: .approved, submittedAt: now.addingTimeInterval(-200_000),
                                studentDisplayName: "Sam Example", decisionReason: nil),
                LinkRequestItem(id: "l2", status: .pending, submittedAt: now.addingTimeInterval(-600),
                                studentDisplayName: nil, decisionReason: nil)
            ])
        return AsyncThrowingStream { $0.yield(snapshot) }
    }

    func ownAssignments() -> AsyncThrowingStream<[OwnAssignment], Error> {
        let own = variant == .guardian ? [] : [OwnAssignment(id: "demo_assignment_001", routeLabel: "Route 17 Morning")]
        return AsyncThrowingStream { $0.yield(own) }
    }

    func tripCheckIn(assignmentId: String) -> AsyncThrowingStream<TripCheckIn, Error> {
        let record = variant == .recorded
            ? CheckInRecord(id: "c1", boarded: true, source: .studentQrClaim,
                            recordedAt: Date().addingTimeInterval(-240))
            : nil
        let trip = TripCheckIn(runId: variant == .noTrip ? nil : "demo_run_001", record: record)
        return AsyncThrowingStream { $0.yield(trip) }
    }

    func recordCheckIn(requestId: String, token: String, runId: String) async throws -> CommandOutcome {
        if variant == .offline { throw URLError(.notConnectedToInternet) }
        if token.hasPrefix("EXP") { return .problem(.expired) }
        return .recorded(CheckInRecord(id: "c9", boarded: true, source: .studentQrClaim, recordedAt: Date()),
                         alreadyRecorded: false)
    }
}
#endif

#if DEBUG
import SwiftUI

/// DEBUG-only screen states for `-ITSSBEnrollmentScreen` screenshots: each
/// builds the real view and drives its real view model with fictional input.
@MainActor
enum PreviewScreens {
    @ViewBuilder
    static func view(_ screen: FamilyScreen, source: any EnrollmentSource) -> some View {
        switch screen {
        case .joinForm: JoinRouteView(model: join(source, code: "DEMX-7K2M-9QXR-4TVW-8ZPN"))
        case .joinExpired: JoinRouteView(model: join(source, code: "EXPX-7K2M-9QXR-4TVW-8ZPN"))
        case .joinSent, .joinUnconfirmed:
            DrivenJoin(model: join(source, code: "DEMX-7K2M-9QXR-4TVW-8ZPN"), name: "Alex Fictional")
        case .joinRefused: DrivenJoin(model: join(source, code: "DEMX-7K2M-9QXR-4TVW-8ZPN"), name: "Refuse Example")
        case .linkSent: DrivenLink(model: LinkStudentViewModel(source: source, initialCode: "MMMM-NNNN-PPPP-QQQQ-RRRR"))
        case .checkInRoute:
            CheckInView(model: CheckInViewModel(source: source,
                                                assignment: OwnAssignment(id: "demo_assignment_001",
                                                                          routeLabel: "Route 17 Morning")))
        case .checkInAccepted:
            DrivenCheckIn(model: CheckInViewModel(source: source,
                                                  assignment: OwnAssignment(id: "demo_assignment_001",
                                                                            routeLabel: "Route 17 Morning")))
        default: EmptyView()
        }
    }

    private static func join(_ source: any EnrollmentSource, code: String) -> JoinRouteViewModel {
        JoinRouteViewModel(source: source, initialCode: code)
    }
}

private struct DrivenJoin: View {
    @State var model: JoinRouteViewModel
    let name: String

    var body: some View {
        JoinRouteView(model: model).task {
            await model.checkCode()
            model.studentName = name
            model.address = "12 Fictional Lane"
            model.stop = .stop("demo_stop_002")
            await model.send()
        }
    }
}

private struct DrivenLink: View {
    @State var model: LinkStudentViewModel

    var body: some View {
        LinkStudentView(model: model).task {
            model.guardianName = "Jordan Guardian"
            await model.send()
        }
    }
}

private struct DrivenCheckIn: View {
    @State var model: CheckInViewModel

    var body: some View {
        CheckInView(model: model).task {
            try? await Task.sleep(for: .milliseconds(300))
            await model.submit(scanned: "AAAA-BBBB-CCCC-DDDD-EEEE")
        }
    }
}
#endif
