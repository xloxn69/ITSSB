@preconcurrency import AVFoundation
import ITSSBDesignSystem
import SwiftUI

/// I17 entry: the student's own approved routes. Guardians see why they can't check in.
struct CheckInListView: View {
    let source: any EnrollmentSource
    @State private var state: LoadState = .loading

    enum LoadState: Equatable {
        case loading, failed, ready([OwnAssignment])
    }

    var body: some View {
        Group {
            switch state {
            case .loading:
                ProgressView("Finding your trip…").frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed:
                ContentUnavailableView("Couldn't find your trip", systemImage: "wifi.exclamationmark",
                                       description: Text("If you can't check in, ask the driver to record you."))
            case .ready(let own) where own.isEmpty:
                ContentUnavailableView("Check-in is for students", systemImage: "person.badge.shield.checkmark",
                                       description: Text("Only a student's own approved account can check in. "
                                                         + "Guardians can't check someone in from home."))
            case .ready(let own):
                List(own) { assignment in
                    NavigationLink(assignment.routeLabel) {
                        CheckInView(model: CheckInViewModel(source: source, assignment: assignment))
                    }
                }
            }
        }
        .navigationTitle("Check in")
        .task {
            do {
                for try await own in source.ownAssignments() { state = .ready(own) }
            } catch {
                state = .failed
            }
        }
    }
}

/// What the scan button can do, from the camera's authorization (docs/13 §7).
/// A denied camera never leads to a blank scanner sheet.
enum CameraAccess: Equatable {
    case ready
    /// iOS hasn't asked yet; the scan button asks first.
    case needsRequest
    /// Denied by the person or restricted on this iPhone: explain, link to Settings.
    case denied
    /// No camera (for example the simulator): typed code only.
    case unavailable

    static func from(_ status: AVAuthorizationStatus, hasCamera: Bool) -> CameraAccess {
        switch status {
        case .denied, .restricted: return .denied
        case _ where !hasCamera: return .unavailable
        case .authorized: return .ready
        case .notDetermined: return .needsRequest
        @unknown default: return .denied
        }
    }
}

/// The camera's permission, injectable so previews and tests never touch the real one.
struct CameraPermission: Sendable {
    var status: @Sendable () -> AVAuthorizationStatus
    var hasCamera: @Sendable () -> Bool
    var request: @Sendable () async -> Bool

    static let system = CameraPermission(
        status: { AVCaptureDevice.authorizationStatus(for: .video) },
        hasCamera: { AVCaptureDevice.default(for: .video) != nil },
        request: { await AVCaptureDevice.requestAccess(for: .video) })

    var access: CameraAccess { CameraAccess.from(status(), hasCamera: hasCamera()) }
}

/// I17 → I18 for one route.
struct CheckInView: View {
    @State var model: CheckInViewModel
    var camera: CameraPermission = .system
    @State private var scanning = false
    @State private var cameraAccess: CameraAccess?
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Form {
            switch model.trip {
            case .loading:
                Section { ProgressView("Checking your trip…") }
            case .failed:
                Section { Text("Couldn't load this trip. Ask the driver to record you if you can't check in.") }
            case .ready(let trip) where trip.runId == nil:
                Section { Text("Your bus isn't running a trip now, so there's nothing to check in to.") }
            case .ready:
                if let record = model.record {
                    recordedSection(record)
                } else {
                    scanSection
                }
            }
        }
        .navigationTitle(model.assignment.routeLabel)
        .task { await model.watch() }
        .onAppear { cameraAccess = camera.access }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            // Leaving the app stops the camera (docs/06 §10).
            case .background: scanning = false
            // Back from Settings: the camera choice may have changed.
            case .active: cameraAccess = camera.access
            default: break
            }
        }
        .sheet(isPresented: $scanning) {
            QRScannerView { text in
                scanning = false
                Task { await model.submit(scanned: text) }
            }
            .ignoresSafeArea()
        }
    }

    /// Asks iOS first if it hasn't asked yet; opens the scanner only with access.
    private func openScanner() async {
        if cameraAccess == .needsRequest {
            _ = await camera.request()
            cameraAccess = camera.access
        }
        if cameraAccess == .ready { scanning = true }
    }

    private func recordedSection(_ record: CheckInRecord) -> some View {
        Section {
            HStack(spacing: AppSpacing.sm) {
                Circle().fill(record.boarded ? AppColors.statusFresh : AppColors.statusAging)
                    .frame(width: AppSpacing.md, height: AppSpacing.md)
                    .accessibilityHidden(true)
                Text("\(record.boarded ? "Checked in" : "Marked not on the bus") at "
                     + "\(record.recordedAt.formatted(date: .omitted, time: .shortened)), \(record.source.familyText)")
            }
            if case .recorded(_, alreadyRecorded: true) = model.outcome {
                Text("You were already checked in on this trip. Nothing new was added.").font(AppFonts.caption)
            }
            Text("This records your scan. It doesn't prove who got on the bus.")
                .font(AppFonts.caption).foregroundStyle(AppColors.textSecondary)
        }
    }

    @ViewBuilder private var scanSection: some View {
        Section {
            switch cameraAccess {
            case .ready, .needsRequest:
                Button("Scan the code on the bus") { Task { await openScanner() } }
                    .buttonStyle(.borderedProminent)
                    .tint(AppColors.brand)
                    .foregroundStyle(AppColors.onBrand)
                    .disabled(model.sending)
            case .denied:
                VStack(alignment: .leading, spacing: AppSpacing.sm) {
                    Text("Camera access is off for ITSSB, so the code can't be scanned. "
                         + "Type the code below, or turn on the camera in Settings.")
                        .font(AppFonts.callout)
                        .foregroundStyle(AppColors.textPrimary)
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    }
                    .font(AppFonts.callout)
                }
            case .unavailable, nil:
                EmptyView()
            }
            TextField("Or type the check-in code", text: $model.codeText)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .font(AppFonts.numeric)
            Button(model.sending ? "Checking in…" : "Check in") {
                Task { await model.submit(scanned: model.codeText) }
            }
            .disabled(model.sending || model.codeText.trimmed.isEmpty)
        } footer: {
            Text("No phone or no connection? The driver can record you.")
        }
        if let outcome = model.outcome {
            Section {
                OutcomeNotice(outcome: outcome) { Task { await model.submit(scanned: model.codeText) } }
            }
        }
    }
}

/// Reads one QR code with the camera, then stops (docs/09 §6 step 4: no
/// repeated submits from repeated frames).
struct QRScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onCode = onCode
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {}

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: ((String) -> Void)?
        private let session = AVCaptureSession()
        private var delivered = false

        override func viewDidLoad() {
            super.viewDidLoad()
            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else { return }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let preview = AVCaptureVideoPreviewLayer(session: session)
            preview.frame = view.bounds
            preview.videoGravity = .resizeAspectFill
            view.layer.addSublayer(preview)
            let session = session
            DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
            // Never keep the camera running behind a backgrounded app (docs/06 §10).
            NotificationCenter.default.addObserver(self, selector: #selector(stopCapture),
                                                   name: UIApplication.didEnterBackgroundNotification, object: nil)
        }

        @objc private func stopCapture() {
            let session = session
            DispatchQueue.global(qos: .userInitiated).async { session.stopRunning() }
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            session.stopRunning()
        }

        nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject],
                                        from connection: AVCaptureConnection) {
            let value = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue
            MainActor.assumeIsolated {
                guard !delivered, let value else { return }
                delivered = true
                session.stopRunning()
                onCode?(value)
            }
        }
    }
}
