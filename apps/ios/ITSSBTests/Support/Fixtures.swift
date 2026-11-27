import Foundation
import XCTest

/// Loads the shared contract fixtures (`packages/contracts/fixtures`), which
/// are copied into the test bundle as the `fixtures` folder.
enum ContractFixture {
    static func data(_ name: String, file: StaticString = #filePath, line: UInt = #line) throws -> Data {
        let bundled = Bundle(for: BundleToken.self)
            .url(forResource: name, withExtension: "json", subdirectory: "fixtures")
        // Fallback for runners that don't copy bundle resources: read the repo copy.
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("../../../../packages/contracts/fixtures/\(name).json")
            .standardizedFileURL
        let url = try XCTUnwrap(
            bundled ?? (FileManager.default.fileExists(atPath: source.path) ? source : nil),
            "Missing fixture \(name).json; run `bun run fixtures` in packages/contracts",
            file: file, line: line
        )
        return try Data(contentsOf: url)
    }

    static func decode<T: Decodable>(_ type: T.Type, _ name: String,
                                     file: StaticString = #filePath, line: UInt = #line) throws -> T {
        try JSONDecoder().decode(T.self, from: data(name, file: file, line: line))
    }

    /// Same JSON object, with one value replaced at a key path ("run.lastPosition.latitude").
    static func patched(_ name: String, _ keyPath: String, _ value: Any) throws -> Data {
        var root = try XCTUnwrap(JSONSerialization.jsonObject(with: data(name)) as? [String: Any])
        root = set(root, keys: keyPath.split(separator: ".").map(String.init), value: value)
        return try JSONSerialization.data(withJSONObject: root)
    }

    private static func set(_ object: [String: Any], keys: [String], value: Any) -> [String: Any] {
        var copy = object
        guard let first = keys.first else { return copy }
        if keys.count == 1 {
            copy[first] = value
        } else {
            copy[first] = set(object[first] as? [String: Any] ?? [:], keys: Array(keys.dropFirst()), value: value)
        }
        return copy
    }

    private final class BundleToken {}
}
