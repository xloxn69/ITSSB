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
        let gpsProblem = contactIsRecent(run, clock: clock, now: now, monotonicNow: monotonicNow)
            ? run.gpsStatus.flatMap { $0 == .valid ? nil : $0 } : nil
        guard let position = run.position else {
            return gpsProblem.map(LivePresentation.gpsUnavailable) ?? .awaitingFirstPosition
        }
        let freshness = position.freshness(at: now, clock: clock, monotonicNow: monotonicNow)
        if freshness == .stale { return .stale }
        if let gpsProblem { return .gpsUnavailable(gpsProblem) }
        return .live(freshness)
    }

    /// `gpsStatus` is the bus's last health report and is never expired by the
    /// backend, so it counts only while the bus was heard from recently: past
    /// the stale cutoff it may describe a bus that has since gone silent.
    private static func contactIsRecent(_ run: TrackedRun, clock: ServerClock, now: Date,
                                        monotonicNow: ContinuousClock.Instant) -> Bool {
        guard let contact = run.lastDeviceContactAt else { return false }
        let age = clock.ageClock(at: now, monotonicNow: monotonicNow).timeIntervalSince(contact)
        return age < FreshnessPolicy.staleAfter
    }

    /// While the phone's own link is down no update can arrive, so nothing is
    /// called fresh: at best the bus is "waiting for an update" (same as web).
    func whileDisconnected(_ connectionLost: Bool) -> LivePresentation {
        connectionLost && self == .live(.fresh) ? .live(.aging) : self
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
