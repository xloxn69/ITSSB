import CryptoKit
import Foundation
import ITSSBDesignSystem
import Observation
import SwiftUI

/// The workflow a person says they want (docs/06 I04). It only chooses which
/// steps the app suggests. It grants nothing: the school decides access on the server.
enum IntendedRole: String, CaseIterable, Identifiable {
    case student, guardian

    var id: String { rawValue }

    var label: String {
        switch self {
        case .student: "Student"
        case .guardian: "Parent or guardian"
        }
    }
}

/// I04 profile, kept on this phone for one signed-in account and never sent to the server.
@MainActor @Observable
final class ProfileStore {
    var name: String { didSet { save() } }
    var role: IntendedRole? { didSet { save() } }

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let key: String

    /// `account` is the sign-in label. Only a hash of it is stored, never the label itself.
    init(account: String?, defaults: UserDefaults = .standard) {
        self.defaults = defaults
        key = Self.key(for: account)
        let stored = defaults.dictionary(forKey: key) as? [String: String] ?? [:]
        name = stored["name"] ?? ""
        role = stored["role"].flatMap(IntendedRole.init(rawValue:))
    }

    /// Removes this account's profile from the phone (sign-out).
    func clear() {
        defaults.removeObject(forKey: key)
    }

    private func save() {
        var value: [String: String] = [:]
        if !name.trimmed.isEmpty { value["name"] = name }
        if let role { value["role"] = role.rawValue }
        if value.isEmpty { defaults.removeObject(forKey: key) } else { defaults.set(value, forKey: key) }
    }

    static func key(for account: String?) -> String {
        let digest = SHA256.hash(data: Data((account ?? "").lowercased().utf8))
        return "profile." + digest.prefix(12).map { String(format: "%02x", $0) }.joined()
    }
}

/// I04 Profile and role.
struct ProfileView: View {
    @Bindable var profile: ProfileStore

    var body: some View {
        Form {
            Section {
                TextField("Your name", text: $profile.name)
                    .textContentType(.name)
                    .autocorrectionDisabled()
            } header: {
                Text("Name")
            }
            Section {
                Picker("I am a", selection: $profile.role) {
                    Text("Not chosen").tag(IntendedRole?.none)
                    ForEach(IntendedRole.allCases) { Text($0.label).tag(IntendedRole?.some($0)) }
                }
            } header: {
                Text("Role")
            } footer: {
                Text("This only changes which steps the app suggests. It doesn't give access to any bus. "
                     + "Your school approves that. This stays on this iPhone.")
            }
        }
        .font(AppFonts.body)
        .navigationTitle("Profile")
    }
}
