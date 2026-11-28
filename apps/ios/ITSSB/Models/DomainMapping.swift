import Foundation

/// Why a wire result could not become a domain value. Surfaces as a
/// recoverable error state, never as "no trip" or an empty route.
enum MappingError: Error, Equatable {
    case unsupportedSchemaVersion(Double)
    case invalidField(String)
}

/// Validates wire DTOs into domain types (docs/06 §7): finite numbers,
/// coordinate ranges, plausible timestamps, nonnegative accuracy, and safe
/// whole revisions.
enum DomainMapping {
    static let schemaVersion: Double = 1
    /// Same bound the backend uses to reject future capture times (contracts `MAX_FUTURE_SKEW_MS`).
    static let maxFutureSkew: TimeInterval = 120
    /// Largest integer a JavaScript number represents exactly.
    static let maxSafeInteger: Double = 9_007_199_254_740_991

    // MARK: myRun

    static func snapshot(from dto: MyRunDTO, receivedAt: Date) throws -> RunSnapshot {
        switch dto {
        case .ready(let ready):
            try checkVersion(ready.schemaVersion)
            let clock = try serverClock(ready.serverNowMs, receivedAt: receivedAt)
            // A running trip has no ended run of its own; only the calendar applies.
            return .ready(assignmentId: ready.assignmentId, routeVersionId: ready.routeVersionId,
                          run: try run(from: ready.run, serverNow: clock.serverNow), clock: clock,
                          notices: TripNotices(endedRun: nil,
                                               serviceNotice: try ready.serviceNotice.map(serviceNotice(from:))))
        case .noActiveRun(let none):
            try checkVersion(none.schemaVersion)
            return .noActiveRun(assignmentId: none.assignmentId, routeVersionId: none.routeVersionId,
                                clock: try serverClock(none.serverNowMs, receivedAt: receivedAt),
                                notices: TripNotices(endedRun: try none.endedRun.map(endedRun(from:)),
                                                     serviceNotice: try none.serviceNotice.map(serviceNotice(from:))))
        case .accessUnavailable(let denied):
            return .accessUnavailable(try reason(denied))
        }
    }

    static func run(from dto: RunDTO, serverNow: Date) throws -> TrackedRun {
        guard let state = RunState(rawValue: dto.state) else { throw MappingError.invalidField("run.state") }
        let gpsStatus = try dto.gpsStatus.map {
            guard let status = GpsStatus(rawValue: $0) else { throw MappingError.invalidField("run.gpsStatus") }
            return status
        }
        return TrackedRun(
            runId: dto.runId,
            state: state,
            liveRevision: try safeWholeNumber(dto.liveRevision, field: "run.liveRevision"),
            busLabel: dto.busLabel,
            lastDeviceContactAt: try dto.lastDeviceContactAtMs.map {
                try timestamp($0, field: "run.lastDeviceContactAtMs")
            },
            gpsStatus: gpsStatus,
            position: dto.lastPosition.flatMap { position(from: $0, serverNow: serverNow) },
            assignedStop: try stop(from: dto.assignedStop, requireStatus: true),
            eta: dto.eta.flatMap(eta(from:))
        )
    }

    /// Nil for an estimate that isn't believable; the rest of the run stays usable.
    static func eta(from dto: EtaDTO) -> RunEta? {
        guard let arrivalAt = try? timestamp(dto.arrivalAtMs, field: "eta.arrivalAtMs"),
              let generatedAt = try? timestamp(dto.generatedAtMs, field: "eta.generatedAtMs"),
              let validUntil = try? timestamp(dto.validUntilMs, field: "eta.validUntilMs"),
              validUntil > generatedAt
        else { return nil }
        return RunEta(arrivalAt: arrivalAt, generatedAt: generatedAt, validUntil: validUntil,
                      algorithmVersion: dto.algorithmVersion, sourceEventId: dto.sourceEventId)
    }

    /// Returns nil for anything that is not a believable observation, so a bad
    /// point never becomes a bus marker. The rest of the run stays usable.
    static func position(from dto: PositionDTO, serverNow: Date) -> LivePosition? {
        guard let coordinate = try? coordinate(dto.latitude, dto.longitude),
              let capturedAt = try? timestamp(dto.capturedAtMs, field: "capturedAtMs"),
              let receivedAt = try? timestamp(dto.receivedAtMs, field: "receivedAtMs"),
              capturedAt <= serverNow.addingTimeInterval(maxFutureSkew),
              [dto.speedMps, dto.headingDegrees, dto.horizontalAccuracyM].allSatisfy({ $0?.isFinite ?? true }),
              (dto.speedMps ?? 0) >= 0,
              (dto.horizontalAccuracyM ?? 0) >= 0,
              (0..<360).contains(dto.headingDegrees ?? 0)
        else { return nil }
        return LivePosition(
            eventId: dto.eventId,
            latitude: coordinate.latitude,
            longitude: coordinate.longitude,
            speedMps: dto.speedMps,
            headingDegrees: dto.headingDegrees,
            horizontalAccuracyM: dto.horizontalAccuracyM,
            capturedAt: capturedAt,
            receivedAt: receivedAt
        )
    }

    // MARK: serverTime

    /// A sample whose round trip took longer than this is too uncertain to verify time.
    static let maxServerTimeRoundTrip: TimeInterval = 5

    /// A verified clock from one `tracking:serverTime` round trip. The server's reading is
    /// pinned to the monotonic midpoint, with half the round trip as uncertainty; a slow
    /// round trip is rejected, so the app stays unverified (never fresh) instead.
    static func verifiedClock(from dto: ServerTimeDTO, sentAt: ContinuousClock.Instant,
                              receivedAt: ContinuousClock.Instant, receivedWallTime: Date) throws -> ServerClock {
        try checkVersion(dto.schemaVersion)
        let roundTrip = sentAt.duration(to: receivedAt).seconds
        guard roundTrip >= 0, roundTrip <= maxServerTimeRoundTrip else {
            throw MappingError.invalidField("serverTime.roundTrip")
        }
        return ServerClock(serverNow: try timestamp(dto.serverNowMs, field: "serverNowMs"),
                           receivedAt: receivedWallTime, isVerified: true,
                           monotonicAt: sentAt.advanced(by: .seconds(roundTrip / 2)),
                           uncertainty: roundTrip / 2)
    }

    // MARK: myRoute

    static func route(from dto: MyRouteDTO) throws -> RouteSnapshot {
        switch dto {
        case .ready(let ready):
            try checkVersion(ready.schemaVersion)
            return .ready(RouteGeometry(
                assignmentId: ready.assignmentId,
                routeVersionId: ready.routeVersionId,
                routeLabel: ready.routeLabel,
                path: try ready.path.map { try coordinate($0.latitude, $0.longitude) },
                assignedStop: try stop(from: ready.assignedStop, requireStatus: false)
            ))
        case .accessUnavailable(let denied):
            return .accessUnavailable(try reason(denied))
        }
    }

    // MARK: myAssignments

    static func assignments(from dto: MyAssignmentsDTO) throws -> AssignmentsSnapshot {
        switch dto {
        case .ready(let ready):
            try checkVersion(ready.schemaVersion)
            return .ready(try ready.assignments.map { item in
                guard let relationship = AssignmentSummary.Relationship(rawValue: item.relationship) else {
                    throw MappingError.invalidField("assignments.relationship")
                }
                return AssignmentSummary(assignmentId: item.assignmentId, relationship: relationship,
                                         studentDisplayName: item.studentDisplayName,
                                         routeLabel: item.routeLabel, stopLabel: item.stopLabel)
            })
        case .accessUnavailable(let denied):
            return .accessUnavailable(try reason(denied))
        }
    }

    // MARK: Ended run and calendar notice

    /// A present but malformed entry throws: dropping it would show "no trip"
    /// in place of a cancellation.
    static func endedRun(from dto: EndedRunDTO) throws -> EndedRun {
        guard let state = EndedRun.State(rawValue: dto.state) else { throw MappingError.invalidField("endedRun.state") }
        guard dto.replacement == nil || dto.replacement == "pending" else {
            throw MappingError.invalidField("endedRun.replacement")
        }
        return EndedRun(runId: dto.runId, state: state,
                        serviceDate: try serviceDate(dto.serviceDate, field: "endedRun.serviceDate"),
                        endedAt: try dto.endedAtMs.map { try timestamp($0, field: "endedRun.endedAtMs") },
                        replacementPending: dto.replacement == "pending",
                        validUntil: try timestamp(dto.validUntilMs, field: "endedRun.validUntilMs"))
    }

    static func serviceNotice(from dto: ServiceNoticeDTO) throws -> ServiceNotice {
        let kind: ServiceNotice.Kind
        switch (dto.status, dto.lateStartMinutes) {
        case ("no_service", nil):
            kind = .noService
        case ("late_start", let minutes?):
            let whole = try safeWholeNumber(minutes, field: "serviceNotice.lateStartMinutes")
            guard whole > 0 else { throw MappingError.invalidField("serviceNotice.lateStartMinutes") }
            kind = .lateStart(minutes: whole)
        default:
            throw MappingError.invalidField("serviceNotice.status")
        }
        return ServiceNotice(serviceDate: try serviceDate(dto.serviceDate, field: "serviceNotice.serviceDate"),
                             kind: kind, notice: dto.notice,
                             validUntil: try timestamp(dto.validUntilMs, field: "serviceNotice.validUntilMs"))
    }

    private static func serviceDate(_ value: String, field: String) throws -> String {
        guard value.wholeMatch(of: /\d{4}-\d{2}-\d{2}/) != nil else { throw MappingError.invalidField(field) }
        return value
    }

    // MARK: Field rules

    static func timestamp(_ ms: Double, field: String) throws -> Date {
        guard ms.isFinite, ms > 0, ms <= maxSafeInteger else { throw MappingError.invalidField(field) }
        return WireTime.date(fromEpochMs: ms)
    }

    static func safeWholeNumber(_ value: Double, field: String) throws -> Int {
        guard value.isFinite, value >= 0, value <= maxSafeInteger, value.rounded() == value else {
            throw MappingError.invalidField(field)
        }
        return Int(value)
    }

    static func coordinate(_ latitude: Double, _ longitude: Double) throws -> Coordinate {
        guard latitude.isFinite, longitude.isFinite,
              (-90...90).contains(latitude), (-180...180).contains(longitude) else {
            throw MappingError.invalidField("coordinate")
        }
        return Coordinate(latitude: latitude, longitude: longitude)
    }

    private static func stop(from dto: StopDTO, requireStatus: Bool) throws -> AssignedStop {
        let status: StopStatus
        if let raw = dto.status {
            guard let parsed = StopStatus(rawValue: raw) else { throw MappingError.invalidField("assignedStop.status") }
            status = parsed
        } else if requireStatus {
            throw MappingError.invalidField("assignedStop.status")
        } else {
            status = .unknown
        }
        return AssignedStop(stopId: dto.stopId, label: dto.label,
                            coordinate: try coordinate(dto.latitude, dto.longitude), status: status)
    }

    private static func serverClock(_ serverNowMs: Double, receivedAt: Date) throws -> ServerClock {
        ServerClock(serverNow: try timestamp(serverNowMs, field: "serverNowMs"), receivedAt: receivedAt)
    }

    private static func checkVersion(_ version: Double) throws {
        guard version == schemaVersion else { throw MappingError.unsupportedSchemaVersion(version) }
    }

    private static func reason(_ dto: AccessUnavailableDTO) throws -> AccessUnavailableReason {
        try checkVersion(dto.schemaVersion)
        guard let reason = AccessUnavailableReason(rawValue: dto.reason) else {
            throw MappingError.invalidField("reason")
        }
        return reason
    }
}
