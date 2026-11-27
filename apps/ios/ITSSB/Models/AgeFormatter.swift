import Foundation

/// Formats a position's age for people: "Updated 8s ago", "Updated 3 min ago".
enum AgeFormatter {
    static func updatedText(age: TimeInterval) -> String {
        let seconds = Int(age.rounded(.down))
        switch seconds {
        case ..<5: return "Updated just now"
        case ..<60: return "Updated \(seconds)s ago"
        case ..<3600: return "Updated \(seconds / 60) min ago"
        default: return "Updated over an hour ago"
        }
    }
}
