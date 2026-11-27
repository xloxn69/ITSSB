@preconcurrency import ConvexMobile
import Foundation

/// Long-lived dependencies, built once per process (docs/06 §3, §8: one
/// Convex client for the process).
@MainActor
struct AppEnvironment {
    let session: SessionStore
    let source: any LiveRunSource

    static func make(configuration: AppConfiguration = .fromBundle(),
                     arguments: [String] = ProcessInfo.processInfo.arguments) -> AppEnvironment {
        #if DEBUG
        if let scenario = scenario(from: arguments) {
            return AppEnvironment(session: SessionStore(auth: PreviewAuthSession()),
                                  source: PreviewLiveRunSource(scenario: scenario))
        }
        #endif
        let client = ConvexClientWithAuth(
            deploymentUrl: configuration.convexURL?.absoluteString ?? "http://127.0.0.1:1",
            authProvider: UnconfiguredAuthProvider()
        )
        // No identity provider yet (docs/17 §5): sign-in is reported as unavailable.
        let auth = ConvexAuthSession(client: client, isConfigured: false)
        return AppEnvironment(session: SessionStore(auth: auth),
                              source: ConvexLiveRunSource(client: ConvexClientQuerying(client: client)))
    }

    #if DEBUG
    /// `-ITSSBScenario stale` launches with fictional data for that screen state.
    static func scenario(from arguments: [String]) -> PreviewScenario? {
        guard let index = arguments.firstIndex(of: "-ITSSBScenario"), index + 1 < arguments.count else { return nil }
        return PreviewScenario(rawValue: arguments[index + 1])
    }
    #endif
}

#if DEBUG
/// Always signed in, for previews and scenario screenshots only.
struct PreviewAuthSession: AuthSession {
    var isConfigured: Bool { true }
    func restore() async -> Bool { true }
    func signIn() async throws {}
    func signOut() async {}
}
#endif
