#if DEBUG
import Foundation

/// DEBUG launch arguments for simulator screenshots. `-ITSSBOpen <name>`
/// pushes one detail screen (`display`, `myRoute`, `stop`, `alert`) so a
/// screenshot needs no taps. Release builds ignore all of this.
enum DebugLaunch {
    static var opens: String? { value(after: "-ITSSBOpen") }

    static func value(after flag: String, in arguments: [String] = ProcessInfo.processInfo.arguments) -> String? {
        guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
        return arguments[index + 1]
    }
}
#endif
