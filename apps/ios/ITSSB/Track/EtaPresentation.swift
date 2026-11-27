import Foundation

/// The arrival estimate as the screen may show it at one instant, or nil.
/// Pure, so tests pin every rule that hides it (docs/08 §8, docs/10 §4).
struct EtaPresentation: Equatable {
    /// "About 6 min" or "Less than a minute".
    let headline: String
    /// Clock time of the estimated arrival.
    let arrivalText: String
    /// "Estimate made 8s ago": an estimate is never shown without its age.
    let madeText: String

    /// Nil whenever the estimate can't be trusted now: time not verified, run not
    /// active, stop not upcoming, no position or a stale one, an estimate made from
    /// another position, or past `validUntil` on the server-aligned clock. The view
    /// re-derives this every second, so an expired estimate disappears on its own.
    static func make(run: TrackedRun, clock: ServerClock, now: Date,
                     monotonicNow: ContinuousClock.Instant = .now,
                     timeZone: TimeZone = .current) -> EtaPresentation? {
        guard let eta = run.eta, clock.isVerified, run.state == .active,
              run.assignedStop.status == .upcoming, let position = run.position,
              eta.sourceEventId == position.eventId,
              position.freshness(at: now, clock: clock, monotonicNow: monotonicNow) != .stale
        else { return nil }
        let serverNow = clock.ageClock(at: now, monotonicNow: monotonicNow)
        guard serverNow < eta.validUntil else { return nil }
        let minutes = Int((eta.arrivalAt.timeIntervalSince(serverNow) / 60).rounded())
        let made = AgeFormatter.updatedText(age: max(0, serverNow.timeIntervalSince(eta.generatedAt)))
            .replacingOccurrences(of: "Updated ", with: "")
        return EtaPresentation(
            headline: minutes < 1 ? "Less than a minute" : "About \(minutes) min",
            arrivalText: StatusCopy.capturedTime(eta.arrivalAt, timeZone: timeZone),
            madeText: "Estimate made \(made)")
    }

    /// Route progress the server inferred from GPS for the assigned stop.
    static func stopProgress(_ run: TrackedRun) -> String? {
        guard run.state == .active else { return nil }
        switch run.assignedStop.status {
        case .atStop: return "The bus is at your stop."
        case .passed: return "The bus has passed your stop."
        case .upcoming, .unknown: return nil
        }
    }
}
