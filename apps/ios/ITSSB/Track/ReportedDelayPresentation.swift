import Foundation

/// The driver's delay report on the Track screen (docs/10 §5, docs/08 §9.4).
/// Shown on an active run even without an arrival estimate, and never as one:
/// the category, the driver's minutes, and how long ago it was made on the bus.
enum ReportedDelayPresentation {
    /// "Driver reported a delay (traffic), about 10 min — reported 3 min ago", or nil
    /// when there is none, the run is not active, or the server-aligned clock has
    /// passed `validUntil`. Re-derived every second, so it disappears on its own.
    static func line(run: TrackedRun, clock: ServerClock, now: Date,
                     monotonicNow: ContinuousClock.Instant = .now) -> String? {
        guard let delay = run.reportedDelay, run.state == .active else { return nil }
        let serverNow = clock.ageClock(at: now, monotonicNow: monotonicNow)
        guard serverNow < delay.validUntil else { return nil }
        let ago = AgeFormatter.updatedText(age: max(0, serverNow.timeIntervalSince(delay.reportedAt)))
            .replacingOccurrences(of: "Updated ", with: "")
        return "\(text(delay)) — reported \(ago)"
    }

    /// The sentence without its age; the same words as the web app.
    static func text(_ delay: ReportedDelay) -> String {
        let what = "Driver reported a delay (\(delay.category.words))"
        guard let minutes = delay.minutes else { return what }
        return "\(what), about \(minutes) min"
    }
}
