import Foundation

/// Which build this is (docs/14 §1-2). Values come from Info.plist, filled by
/// build settings: `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in
/// project.yml, `ITSSB_ENVIRONMENT` and `ITSSB_SOURCE_REVISION` in
/// `Config/Base.xcconfig`, overridden for a release build by the release
/// runbook (docs/runbooks/release.md). A missing or unknown environment counts
/// as development, so a build never claims production by accident.
struct BuildInfo: Equatable {
    enum Environment: String, Equatable {
        case development, staging, production
    }

    let version: String?
    let build: String?
    let environment: Environment
    let sourceRevision: String?

    init(infoDictionary: [String: Any]) {
        func text(_ key: String) -> String? {
            guard let value = (infoDictionary[key] as? String)?.trimmingCharacters(in: .whitespaces),
                  !value.isEmpty else { return nil }
            return value
        }
        version = text("CFBundleShortVersionString")
        build = text("CFBundleVersion")
        environment = text("ITSSBEnvironment").flatMap(Environment.init(rawValue:)) ?? .development
        sourceRevision = text("ITSSBSourceRevision")
    }

    static func fromBundle(_ bundle: Bundle = .main) -> BuildInfo {
        BuildInfo(infoDictionary: bundle.infoDictionary ?? [:])
    }

    /// One line for support: "0.1.0 (1) abc1234 development".
    var summary: String {
        let commit = sourceRevision.map { String($0.prefix(7)) } ?? "unknown"
        return "\(version ?? "unknown") (\(build ?? "unknown")) \(commit) \(environment.rawValue)"
    }
}
