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
