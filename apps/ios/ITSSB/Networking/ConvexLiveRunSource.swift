import Combine
@preconcurrency import ConvexMobile
import Foundation

/// The minimal query interface `ConvexLiveRunSource` needs. The app passes a
/// `ConvexClientQuerying`; tests pass a fake that never touches the network.
///
/// `transform` runs on each decoded value as it arrives, so only validated,
/// `Sendable` domain values cross concurrency boundaries. If it throws, the
/// stream finishes with that error.
protocol ConvexQuerying: Sendable {
    func subscribe<T: Decodable, Value: Sendable>(
        _ name: String, args: [String: String], as type: T.Type,
        transform: @escaping @Sendable (T) throws -> Value
    ) -> AsyncThrowingStream<Value, Error>

    /// Runs a mutation once. Mutation results are never served from the query cache.
    func mutation<T: Decodable, Value: Sendable>(
        _ name: String, as type: T.Type, transform: @escaping @Sendable (T) throws -> Value
    ) async throws -> Value
}

/// `LiveRunSource` over the family tracking queries (docs/08 §8).
///
/// Every value is validated by `DomainMapping` before it leaves this type,
/// and SDK errors become `TrackingError`s so the UI can tell an expired
/// session from a dropped connection.
struct ConvexLiveRunSource: LiveRunSource {
    let client: any ConvexQuerying
    /// Injected so tests control the receipt time used for clock alignment.
    var now: @Sendable () -> Date = { Date() }

    func assignments() -> AsyncThrowingStream<AssignmentsSnapshot, Error> {
        mapErrors(client.subscribe("tracking:myAssignments", args: [:], as: MyAssignmentsDTO.self) {
            try DomainMapping.assignments(from: $0)
        })
    }

    /// Run snapshots, re-measured against verified server time once `tracking:serverTime`
    /// answers (docs/08 §8.1). Until then each snapshot carries an unverified clock.
    func run(assignmentId: String) -> AsyncThrowingStream<RunSnapshot, Error> {
        let now = now
        let client = client
        let args = ["assignmentId": assignmentId]
        let snapshots = mapErrors(client.subscribe("tracking:myRun", args: args, as: MyRunDTO.self) {
            try DomainMapping.snapshot(from: $0, receivedAt: now())
        })
        return AsyncThrowingStream { continuation in
            let gate = VerifiedClockGate(continuation: continuation)
            let timeTask = Task {
                let sentAt = now()
                guard let clock = try? await client.mutation("tracking:serverTime", as: ServerTimeDTO.self, transform: {
                    try DomainMapping.verifiedClock(from: $0, sentAt: sentAt, receivedAt: now())
                }) else { return } // Offline or rejected: stay unverified, so nothing shows as fresh.
                await gate.verify(with: clock)
            }
            let runTask = Task {
                do {
                    for try await snapshot in snapshots { await gate.forward(snapshot) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                runTask.cancel()
                timeTask.cancel()
            }
        }
    }

    func route(assignmentId: String) -> AsyncThrowingStream<RouteSnapshot, Error> {
        let args = ["assignmentId": assignmentId]
        return mapErrors(client.subscribe("tracking:myRoute", args: args, as: MyRouteDTO.self) {
            try DomainMapping.route(from: $0)
        })
    }

    /// Forwards values unchanged and converts any failure into a `TrackingError`.
    private func mapErrors<Value: Sendable>(
        _ upstream: AsyncThrowingStream<Value, Error>
    ) -> AsyncThrowingStream<Value, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await value in upstream { continuation.yield(value) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: Self.trackingError(error))
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    static func trackingError(_ error: Error) -> TrackingError {
        if let tracking = error as? TrackingError { return tracking }
        if error is DecodingError || error is MappingError { return .invalidData }
        if case let .ConvexError(data)? = error as? ClientError, data.contains("UNAUTHENTICATED") {
            return .sessionExpired
        }
        return .transport
    }
}

/// Serializes snapshot delivery with the arrival of verified time, so an older
/// unverified snapshot can never be yielded after its verified replacement.
private actor VerifiedClockGate {
    private let continuation: AsyncThrowingStream<RunSnapshot, Error>.Continuation
    private var verified: ServerClock?
    private var latest: RunSnapshot?

    init(continuation: AsyncThrowingStream<RunSnapshot, Error>.Continuation) {
        self.continuation = continuation
    }

    func forward(_ snapshot: RunSnapshot) {
        latest = snapshot
        continuation.yield(verified.map { snapshot.with(clock: $0) } ?? snapshot)
    }

    func verify(with clock: ServerClock) {
        verified = clock
        if let latest { continuation.yield(latest.with(clock: clock)) }
    }
}

/// Adapts the process-wide Convex client (docs/06 §8: one client per process).
///
/// `@unchecked Sendable`: `ConvexClient` isn't annotated, but its FFI client
/// and Combine subjects are safe to use from any thread, and this wrapper
/// stores nothing mutable.
final class ConvexClientQuerying: ConvexQuerying, @unchecked Sendable {
    fileprivate let client: ConvexClient

    init(client: ConvexClient) {
        self.client = client
    }

    func subscribe<T: Decodable, Value: Sendable>(
        _ name: String, args: [String: String], as type: T.Type,
        transform: @escaping @Sendable (T) throws -> Value
    ) -> AsyncThrowingStream<Value, Error> {
        let publisher = client.subscribe(to: name, with: args, yielding: type)
        return AsyncThrowingStream { continuation in
            let box = CancellableBox()
            box.cancellable = publisher.sink(
                receiveCompletion: { completion in
                    if case let .failure(error) = completion {
                        continuation.finish(throwing: error)
                    } else {
                        continuation.finish()
                    }
                },
                receiveValue: { dto in
                    do {
                        continuation.yield(try transform(dto))
                    } catch {
                        continuation.finish(throwing: error)
                        box.cancellable?.cancel()
                    }
                }
            )
            continuation.onTermination = { _ in box.cancellable?.cancel() }
        }
    }
}

extension ConvexClientQuerying {
    func mutation<T: Decodable, Value: Sendable>(
        _ name: String, as type: T.Type, transform: @escaping @Sendable (T) throws -> Value
    ) async throws -> Value {
        try transform(try await client.mutation(name, with: nil))
    }
}

/// Holds a Combine subscription so a `@Sendable` termination handler can cancel it.
/// `@unchecked Sendable`: `AnyCancellable.cancel()` is thread-safe.
private final class CancellableBox: @unchecked Sendable {
    var cancellable: AnyCancellable?
}
