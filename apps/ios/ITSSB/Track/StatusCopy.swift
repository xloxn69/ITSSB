import Foundation

/// The words on the trip status card for one instant. Pure, so tests can pin
/// the rule that stale or missing data is never described as live.
struct StatusCopy: Equatable {
    enum Tone: Equatable { case fresh, aging, stale, unknown }

    let title: String
    let detail: String
    /// "Updated 12s ago", or nil when there is no position to age.
    let age: String?
    let systemImage: String
    let tone: Tone

    static func make(_ presentation: LivePresentation, run: TrackedRun, clock: ServerClock, now: Date,
                     timeZone: TimeZone = .current) -> StatusCopy {
        let age = run.position.map { AgeFormatter.updatedText(age: $0.age(at: now, clock: clock)) }
        let stop = run.assignedStop.label
        switch presentation {
        case .live(.fresh):
            return StatusCopy(title: "\(run.busLabel) is on the way", detail: "Heading toward \(stop).",
                              age: age, systemImage: "location.fill", tone: .fresh)
        case .live(.aging):
            return StatusCopy(title: "Waiting for an update",
                              detail: "\(run.busLabel) hasn't reported for a little while.",
                              age: age, systemImage: "clock", tone: .aging)
        case .live(.stale), .stale:
            let reported = run.position.map { capturedTime($0.capturedAt, timeZone: timeZone) } ?? "earlier"
            return StatusCopy(title: "Last known location",
                              detail: "Reported at \(reported). The bus may have moved since then.",
                              age: age, systemImage: "exclamationmark.triangle.fill", tone: .stale)
        case .awaitingFirstPosition:
            return StatusCopy(title: "Waiting for the bus's location",
                              detail: "The trip has started, but \(run.busLabel) hasn't reported a location yet.",
                              age: nil, systemImage: "location.slash", tone: .unknown)
        case .gpsUnavailable(let status):
            let problem = status == .receiverMissing
                ? "Its GPS receiver isn't working."
                : "Its GPS can't get a signal right now."
            return StatusCopy(title: "Bus location unavailable",
                              detail: "\(run.busLabel) is connected. \(problem) The marker shows its last fix.",
                              age: age, systemImage: "location.slash.fill", tone: .stale)
        case .notLive(let state):
            return StatusCopy(title: notLiveTitle(state), detail: "There's no live bus location for this trip.",
                              age: nil, systemImage: "bus", tone: .unknown)
        }
    }

    private static func notLiveTitle(_ state: RunState) -> String {
        switch state {
        case .completed: "Trip completed"
        case .cancelled: "Trip cancelled"
        case .scheduled: "Trip hasn't started"
        case .active: "Trip in progress"
        }
    }

    static func capturedTime(_ date: Date, timeZone: TimeZone) -> String {
        var style = Date.FormatStyle(date: .omitted, time: .shortened)
        style.timeZone = timeZone
        return date.formatted(style)
    }
}
