import Foundation
import Observation

/// Explicit screen states (docs/06). Never show a map that looks live while
/// loading, without a run, or without access.
enum TrackState: Equatable {
    case loading
    case noActiveRun
    case accessUnavailable
    case tracking(LivePosition)
    case failed(message: String)
}

/// Where live positions come from. The Convex-backed source is added in the
/// backend milestone; previews and tests use `PreviewLiveRunSource`.
protocol LiveRunSource: Sendable {
    func currentPosition() async throws -> TrackState
}

@MainActor
@Observable
final class TrackViewModel {
    private(set) var state: TrackState = .loading
    private let source: any LiveRunSource

    init(source: any LiveRunSource) {
        self.source = source
    }

    func refresh() async {
        do {
            state = try await source.currentPosition()
        } catch {
            state = .failed(message: "Couldn't load the bus position. Check your connection.")
        }
    }
}

/// Fictional data for previews and the simulator. Not a real route.
struct PreviewLiveRunSource: LiveRunSource {
    var capturedSecondsAgo: TimeInterval = 8

    func currentPosition() async throws -> TrackState {
        let captured = Date().addingTimeInterval(-capturedSecondsAgo)
        return .tracking(LivePosition(
            eventId: "5fe2a60d-7c11-45b9-995d-f50192adea42",
            latitude: 34.1,
            longitude: -83.98,
            speedMps: 7.2,
            headingDegrees: 95,
            horizontalAccuracyM: nil,
            capturedAt: captured,
            receivedAt: captured.addingTimeInterval(0.4)
        ))
    }
}
