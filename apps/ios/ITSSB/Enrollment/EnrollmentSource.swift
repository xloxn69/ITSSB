import Combine
@preconcurrency import ConvexMobile
import Foundation

/// Family enrollment, guardian link and check-in calls (docs/08 §9.1–§9.2).
/// The server derives the caller from the session; nothing here sends a role,
/// a student ID or a user ID.
protocol EnrollmentSource: Sendable {
    func preview(token: String) async throws -> PreviewResult
    func requestEnrollment(_ input: EnrollmentRequestInput) async throws -> CommandOutcome
    func requestLink(requestId: String, token: String, guardianName: String) async throws -> CommandOutcome
    func requests() -> AsyncThrowingStream<RequestsSnapshot, Error>
    func ownAssignments() -> AsyncThrowingStream<[OwnAssignment], Error>
    func tripCheckIn(assignmentId: String) -> AsyncThrowingStream<TripCheckIn, Error>
    func recordCheckIn(requestId: String, token: String, runId: String) async throws -> CommandOutcome
}

/// `EnrollmentSource` over the process-wide Convex client.
///
/// `@unchecked Sendable`: `ConvexClient` isn't annotated, but its FFI client
/// and Combine subjects are thread-safe, and this type stores nothing mutable.
final class ConvexEnrollmentSource: EnrollmentSource, @unchecked Sendable {
    private let client: ConvexClient

    init(client: ConvexClient) {
        self.client = client
    }

    func preview(token: String) async throws -> PreviewResult {
        for try await value in subscribe("enrollment:previewInvitation", ["token": token], PreviewInvitationDTO.self,
                                         EnrollmentMapping.preview) {
            return value
        }
        throw CancellationError()
    }

    func requestEnrollment(_ input: EnrollmentRequestInput) async throws -> CommandOutcome {
        try await command("enrollment:request", [
            "requestId": input.requestId, "token": input.token, "studentName": input.studentName,
            "address": input.address, "stopId": input.stopId, "note": input.note
        ])
    }

    func requestLink(requestId: String, token: String, guardianName: String) async throws -> CommandOutcome {
        try await command("guardianLinks:request",
                          ["requestId": requestId, "token": token, "guardianName": guardianName])
    }

    func recordCheckIn(requestId: String, token: String, runId: String) async throws -> CommandOutcome {
        try await command("checkIns:record", ["requestId": requestId, "token": token, "runId": runId])
    }

    func requests() -> AsyncThrowingStream<RequestsSnapshot, Error> {
        let enrollment = subscribe("enrollment:myRequests", [:], RequestListDTO<MyEnrollmentRequestDTO>.self,
                                   EnrollmentMapping.enrollmentItems)
        let links = subscribe("guardianLinks:myRequests", [:], RequestListDTO<MyLinkRequestDTO>.self,
                              EnrollmentMapping.linkItems)
        return AsyncThrowingStream { continuation in
            let latest = LatestPair<[EnrollmentRequestItem], [LinkRequestItem]>()
            let emit: @Sendable () async -> Void = {
                guard let (routes, links) = await latest.both() else { return }
                continuation.yield(RequestsSnapshot(enrollment: routes, links: links))
            }
            let first = Task {
                do { for try await value in enrollment { await latest.setFirst(value); await emit() } } catch {
                    continuation.finish(throwing: error)
                }
            }
            let second = Task {
                do { for try await value in links { await latest.setSecond(value); await emit() } } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in first.cancel(); second.cancel() }
        }
    }

    func ownAssignments() -> AsyncThrowingStream<[OwnAssignment], Error> {
        subscribe("tracking:myAssignments", [:], MyAssignmentsDTO.self, EnrollmentMapping.ownAssignments)
    }

    func tripCheckIn(assignmentId: String) -> AsyncThrowingStream<TripCheckIn, Error> {
        subscribe("checkIns:forAssignment", ["assignmentId": assignmentId], AssignmentCheckInDTO.self,
                  EnrollmentMapping.tripCheckIn)
    }

    private func command(_ name: String, _ args: [String: String?]) async throws -> CommandOutcome {
        let encodable: [String: ConvexEncodable?] = args.mapValues { $0 }
        let dto: CommandResultDTO = try await client.mutation(name, with: encodable)
        return EnrollmentMapping.outcome(dto)
    }

    private func subscribe<T: Decodable, Value: Sendable>(
        _ name: String, _ args: [String: String], _ type: T.Type,
        _ transform: @escaping @Sendable (T) throws -> Value
    ) -> AsyncThrowingStream<Value, Error> {
        let publisher = client.subscribe(to: name, with: args, yielding: type)
        return AsyncThrowingStream { continuation in
            let box = SubscriptionBox()
            box.cancellable = publisher.sink(
                receiveCompletion: { completion in
                    if case let .failure(error) = completion { continuation.finish(throwing: error) } else {
                        continuation.finish()
                    }
                },
                receiveValue: { dto in
                    do { continuation.yield(try transform(dto)) } catch {
                        continuation.finish(throwing: error)
                        box.cancellable?.cancel()
                    }
                }
            )
            continuation.onTermination = { _ in box.cancellable?.cancel() }
        }
    }
}

/// `@unchecked Sendable`: `AnyCancellable.cancel()` is thread-safe.
private final class SubscriptionBox: @unchecked Sendable {
    var cancellable: AnyCancellable?
}

/// The latest value from each of two streams.
private actor LatestPair<A: Sendable, B: Sendable> {
    private var first: A?
    private var second: B?
    func setFirst(_ value: A) { first = value }
    func setSecond(_ value: B) { second = value }
    func both() -> (A, B)? {
        guard let first, let second else { return nil }
        return (first, second)
    }
}
