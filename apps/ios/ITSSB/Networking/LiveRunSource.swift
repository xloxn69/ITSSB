import Foundation

/// Where tracking data comes from (docs/06 §3 `BusRepository`). The app uses
/// `ConvexLiveRunSource`; previews, screenshots, and tests use fixtures or
/// mocks that produce the same validated domain values.
///
/// Each stream is a live subscription: it yields a new snapshot whenever the
/// server's answer changes and ends (or throws) when the subscription does.
/// Cancelling the consuming task cancels the subscription.
protocol LiveRunSource: Sendable {
    func assignments() -> AsyncThrowingStream<AssignmentsSnapshot, Error>
    func run(assignmentId: String) -> AsyncThrowingStream<RunSnapshot, Error>
    func route(assignmentId: String) -> AsyncThrowingStream<RouteSnapshot, Error>
    /// The phone's live link to the backend: `true` connected, `false`
    /// reconnecting. Subscriptions do not fail when the link drops; they go
    /// quiet, so this is the only way to tell "my phone is offline" from
    /// "the bus stopped reporting" (docs/06 I25).
    func connection() -> AsyncStream<Bool>
}

extension LiveRunSource {
    /// Sources with no network (fixtures, previews) are always connected.
    func connection() -> AsyncStream<Bool> {
        AsyncStream { $0.yield(true) }
    }
}

/// Failures a source reports. Each maps to a distinct screen: an expired
/// session is not "no access", and a transport failure is never "no trip".
enum TrackingError: Error, Equatable {
    /// The backend rejected the session; the person must sign in again.
    case sessionExpired
    /// Network, server, or SDK failure. Retrying may help.
    case transport
    /// The server answered with something that failed contract validation.
    case invalidData
}
