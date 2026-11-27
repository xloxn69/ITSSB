import Foundation

/// What the tracking screen may honestly claim about the bus at one instant.
///
/// A pure function of the run, the server clock, and "now", so the screen is
/// re-derived every second and moves from live to stale without another update
/// (docs/06 §9). Every case that hides the marker hides it because there is no
/// believable current position to show, never to make the screen look calmer.
enum LivePresentation: Equatable {
    /// A recent position. `aging` means an update is overdue but not yet stale.
    case live(Freshness)
    /// The last known position is past the stale cutoff: dim it and show its capture time.
    case stale
    /// The run is active but the bus hasn't reported a usable position yet.
    case awaitingFirstPosition
    /// The bus is reporting, but its GPS has no fix or no receiver (docs/06 I26).
    case gpsUnavailable(GpsStatus)
    /// Completed, cancelled, or not yet started: no live marker or countdown (docs/08 §8).
    case notLive(RunState)

    static func make(run: TrackedRun, clock: ServerClock, now: Date,
                     monotonicNow: ContinuousClock.Instant = .now) -> LivePresentation {
        guard run.state.showsLiveMarker else { return .notLive(run.state) }
        let gpsProblem = run.gpsStatus.flatMap { $0 == .valid ? nil : $0 }
        guard let position = run.position else {
            return gpsProblem.map(LivePresentation.gpsUnavailable) ?? .awaitingFirstPosition
        }
        let freshness = position.freshness(at: now, clock: clock, monotonicNow: monotonicNow)
        if freshness == .stale { return .stale }
        if let gpsProblem { return .gpsUnavailable(gpsProblem) }
        return .live(freshness)
    }

    /// Whether to draw the bus marker at the last position.
    var showsMarker: Bool {
        switch self {
        case .live, .stale, .gpsUnavailable: true
        case .awaitingFirstPosition, .notLive: false
        }
    }

    /// Whether the marker must look like an old, last-known point.
    var dimsMarker: Bool {
        switch self {
        case .live: false
        case .stale, .gpsUnavailable, .awaitingFirstPosition, .notLive: true
        }
    }
}
