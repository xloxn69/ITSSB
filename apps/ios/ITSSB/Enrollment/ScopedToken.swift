import Foundation

/// Client-side parsing of a scanned or typed code (docs/09 §3). Same rules as
/// `normalizeToken` and `parseScannedToken` in `packages/contracts`. Parsing
/// never grants anything: the backend validates purpose, expiry, revocation
/// and scope.
enum ScopedToken {
    enum Purpose: String, Sendable {
        case routeEnrollment = "route_enrollment"
        case guardianLink = "guardian_link"
        case tripCheckIn = "trip_check_in"

        var linkPath: String {
            switch self {
            case .routeEnrollment: "/join"
            case .guardianLink: "/link"
            case .tripCheckIn: "/checkin"
            }
        }
    }

    static let length = 20
    static let alphabet = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    /// The canonical 20-character code, or nil if the text can't be one.
    static func normalize(_ raw: String) -> String? {
        guard raw.count <= 64 else { return nil }
        let compact = raw.filter { !$0.isWhitespace && $0 != "-" }.uppercased()
        guard compact.count == length, compact.allSatisfy(alphabet.contains) else { return nil }
        return compact
    }

    /// `ABCD-EFGH-JKMN-PQRS-TVWX`, for display.
    static func format(_ token: String) -> String {
        stride(from: 0, to: token.count, by: 4).map { start -> String in
            let from = token.index(token.startIndex, offsetBy: start)
            let end = token.index(from, offsetBy: min(4, token.count - start))
            return String(token[from..<end])
        }.joined(separator: "-")
    }

    /// A code from a typed value or a scanned `https://<allowed host><path>?token=…` link.
    static func parse(_ text: String, purpose: Purpose, allowedHosts: Set<String>) -> String? {
        guard text.count <= 256 else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let bare = normalize(trimmed) { return bare }
        guard let url = URLComponents(string: trimmed),
              url.scheme == "https",
              let host = url.host?.lowercased(),
              allowedHosts.contains(url.port.map { "\(host):\($0)" } ?? host),
              url.path == purpose.linkPath,
              url.fragment == nil,
              let items = url.queryItems, items.count == 1,
              items[0].name == "token", let value = items[0].value
        else { return nil }
        return normalize(value)
    }
}
