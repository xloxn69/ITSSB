import ITSSBDesignSystem
import SwiftUI
import UIKit

/// I-alerts: notification permission, per-student approaching-alert choice,
/// and the in-app inbox (docs/08 §9.1, docs/10 §8).
struct AlertsView: View {
    @State private var model: AlertsViewModel
    let registrar: PushRegistrar?

    init(tracking: any LiveRunSource, notifications: any NotificationSource, registrar: PushRegistrar?) {
        _model = State(initialValue: AlertsViewModel(tracking: tracking, notifications: notifications))
        self.registrar = registrar
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Alerts")
        }
        .onAppear { model.start() }
        .onDisappear { model.stop() }
        .task { await registrar?.refresh() }
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .loading:
            ProgressView("Loading alerts…")
                .font(AppFonts.body)
                .foregroundStyle(AppColors.textSecondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .unavailable:
            ContentUnavailableView("Alerts not available", systemImage: "bell.slash",
                                   description: Text("This account isn't linked to an approved route."))
        case .failed:
            ContentUnavailableView("Couldn't load alerts", systemImage: "wifi.exclamationmark",
                                   description: Text("Check your connection. Alerts will show again when it's back."))
        case .ready:
            List {
                if let registrar { PermissionSection(registrar: registrar) }
                ForEach(model.assignments) { assignment in
                    PreferenceSection(assignment: assignment, preference: model.preferences[assignment.assignmentId],
                                      saving: model.saving.contains(assignment.assignmentId),
                                      failed: model.saveFailed.contains(assignment.assignmentId)) { enabled, minutes in
                        Task { await model.save(assignmentId: assignment.assignmentId, enabled: enabled,
                                                minutes: minutes) }
                    }
                }
                Section("Recent alerts") {
                    if model.alerts.isEmpty {
                        Text("No alerts yet.")
                            .font(AppFonts.callout)
                            .foregroundStyle(AppColors.textSecondary)
                    }
                    ForEach(model.alerts) { AlertRow(alert: $0) }
                }
            }
        }
    }
}

private struct PermissionSection: View {
    let registrar: PushRegistrar

    var body: some View {
        Section {
            switch registrar.permission {
            case .authorized, .provisional:
                Label(registrar.pushEnabled ? "Notifications are on for this iPhone."
                          : "Notifications are allowed. This iPhone isn't registered for them yet.",
                      systemImage: registrar.pushEnabled ? "bell.badge" : "bell")
            case .notDetermined:
                VStack(alignment: .leading, spacing: AppSpacing.sm) {
                    Text("Allow notifications to hear about your bus when the app is closed.")
                    Button("Allow notifications") { Task { await registrar.requestPermission() } }
                        .buttonStyle(.borderedProminent)
                        .tint(AppColors.brand)
                        .foregroundStyle(AppColors.onBrand)
                }
            case .denied:
                VStack(alignment: .leading, spacing: AppSpacing.sm) {
                    Text("Notifications are off for ITSSB in Settings. Alerts still appear in this list.")
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    }
                }
            }
            if registrar.registrationFailed {
                Text("Couldn't update this iPhone's notification settings. Will retry when you return.")
                    .foregroundStyle(AppColors.statusStale)
            }
        }
        .font(AppFonts.callout)
        .foregroundStyle(AppColors.textPrimary)
    }
}

private struct PreferenceSection: View {
    let assignment: AssignmentSummary
    let preference: NotificationPreference?
    let saving: Bool
    let failed: Bool
    let onChange: (Bool, Int) -> Void

    private static let choices = [2, 3, 5, 7, 10, 15]

    var body: some View {
        Section(assignment.studentDisplayName) {
            if let preference {
                Toggle("Alert me when the bus is about to reach \(assignment.stopLabel)", isOn: Binding(
                    get: { preference.approachingEnabled },
                    set: { onChange($0, preference.approachingMinutes) }))
                    .disabled(saving)
                Picker("How far ahead", selection: Binding(
                    get: { preference.approachingMinutes },
                    set: { onChange(true, $0) })) {
                    ForEach(Array(Set(Self.choices + [preference.approachingMinutes])).sorted(), id: \.self) {
                        Text("About \($0) min").tag($0)
                    }
                }
                .disabled(saving || !preference.approachingEnabled)
                if failed {
                    Text("Couldn't save. Your previous choice is still in effect.")
                        .foregroundStyle(AppColors.statusStale)
                }
            } else {
                Text("Loading…").foregroundStyle(AppColors.textSecondary)
            }
        }
        .font(AppFonts.callout)
    }
}

private struct AlertRow: View {
    let alert: AlertItem

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.xxs) {
            Text("Bus approaching \(alert.stopLabel)")
                .font(AppFonts.headline)
                .foregroundStyle(AppColors.textPrimary)
            Text("Estimated arrival \(time(alert.predictedArrivalAt)), "
                 + "from an estimate made at \(time(alert.predictionGeneratedAt)).")
                .font(AppFonts.caption)
                .foregroundStyle(AppColors.textSecondary)
        }
        .accessibilityElement(children: .combine)
    }

    private func time(_ date: Date) -> String { StatusCopy.capturedTime(date, timeZone: .current) }
}
