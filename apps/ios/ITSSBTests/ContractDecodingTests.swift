import XCTest
@testable import ITSSB

/// Decodes the shared contract fixtures (docs/08 §10) and maps them into domain types.
final class ContractDecodingTests: XCTestCase {
    private let received = Date(timeIntervalSince1970: 1_795_609_085.6)

    private func runSnapshot(_ name: String) throws -> RunSnapshot {
        try DomainMapping.snapshot(from: ContractFixture.decode(MyRunDTO.self, name), receivedAt: received)
    }

    private func runSnapshot(data: Data) throws -> RunSnapshot {
        try DomainMapping.snapshot(from: JSONDecoder().decode(MyRunDTO.self, from: data), receivedAt: received)
    }

    func testReadyRunDecodesEveryField() throws {
        guard case let .ready(assignmentId, routeVersionId, run, clock) = try runSnapshot("myRun.ready") else {
            return XCTFail("expected ready")
        }
        XCTAssertEqual(assignmentId, "demo_assignment_001")
        XCTAssertEqual(routeVersionId, "demo_route_version_003")
        XCTAssertEqual(run.runId, "demo_run_001")
        XCTAssertEqual(run.state, .active)
        XCTAssertEqual(run.liveRevision, 27)
        XCTAssertEqual(run.busLabel, "Bus 12")
        XCTAssertEqual(run.gpsStatus, .valid)
        XCTAssertEqual(run.assignedStop.label, "Oak & Pine")
        XCTAssertEqual(run.assignedStop.status, .upcoming)
        XCTAssertEqual(run.assignedStop.coordinate, Coordinate(latitude: 34.105, longitude: -83.975))
        XCTAssertEqual(clock.serverNow.timeIntervalSince1970, 1_795_609_085.5, accuracy: 0.000_1)

        let position = try XCTUnwrap(run.position)
        XCTAssertEqual(position.eventId, "5fe2a60d-7c11-45b9-995d-f50192adea42")
        XCTAssertEqual(position.latitude, 34.1)
        XCTAssertEqual(position.longitude, -83.98)
        XCTAssertEqual(position.speedMps, 7.2)
        XCTAssertEqual(position.headingDegrees, 95)
        XCTAssertNil(position.horizontalAccuracyM, "explicit null decodes as nil")
    }

    func testExplicitNullsDecodeAsNil() throws {
        guard case let .ready(_, _, run, _) = try runSnapshot("myRun.readyNoPosition") else {
            return XCTFail("expected ready")
        }
        XCTAssertNil(run.position, "no position must never become a marker")
        XCTAssertNil(run.gpsStatus)
        XCTAssertNil(run.lastDeviceContactAt)
        XCTAssertEqual(run.liveRevision, 0)
        XCTAssertEqual(run.assignedStop.status, .unknown)
    }

    func testStaleFixtureCarriesAccuracy() throws {
        guard case let .ready(_, _, run, _) = try runSnapshot("myRun.stale") else { return XCTFail("expected ready") }
        XCTAssertEqual(run.position?.horizontalAccuracyM, 12.5)
        XCTAssertNil(run.position?.speedMps)
    }

    func testNoActiveRun() throws {
        XCTAssertEqual(try runSnapshot("myRun.noActiveRun"),
                       .noActiveRun(assignmentId: "demo_assignment_001", routeVersionId: "demo_route_version_003"))
    }

    func testAccessUnavailable() throws {
        XCTAssertEqual(try runSnapshot("myRun.accessUnavailable"), .accessUnavailable(.notPermitted))
        let route = try DomainMapping.route(from: ContractFixture.decode(MyRouteDTO.self, "myRoute.accessUnavailable"))
        XCTAssertEqual(route, .accessUnavailable(.unauthenticated))
    }

    func testRouteGeometry() throws {
        guard case let .ready(route) = try DomainMapping.route(
            from: ContractFixture.decode(MyRouteDTO.self, "myRoute.ready")) else { return XCTFail("expected ready") }
        XCTAssertEqual(route.routeVersionId, "demo_route_version_003")
        XCTAssertEqual(route.routeLabel, "Route 17 Morning")
        XCTAssertEqual(route.path.count, 5)
        XCTAssertEqual(route.path.first, Coordinate(latitude: 34.092, longitude: -83.995))
        XCTAssertEqual(route.assignedStop.stopId, "demo_stop_003")
    }

    func testAssignments() throws {
        let result = try DomainMapping.assignments(
            from: ContractFixture.decode(MyAssignmentsDTO.self, "myAssignments.ready"))
        guard case let .ready(list) = result else { return XCTFail("expected ready") }
        XCTAssertEqual(list.map(\.assignmentId), ["demo_assignment_001"])
        XCTAssertEqual(list.first?.relationship, .self)
        XCTAssertEqual(list.first?.studentDisplayName, "Sam Example")
    }

    // MARK: Validation

    func testInvalidCoordinatesDropThePositionButKeepTheRun() throws {
        for (key, value) in [("latitude", 91.0), ("longitude", -181.0)] {
            let data = try ContractFixture.patched("myRun.ready", "run.lastPosition.\(key)", value)
            guard case let .ready(_, _, run, _) = try runSnapshot(data: data) else { return XCTFail("expected ready") }
            XCTAssertNil(run.position, "\(key) out of range must not become a marker")
            XCTAssertEqual(run.assignedStop.label, "Oak & Pine")
        }
    }

    func testFarFutureCaptureTimeIsRejected() throws {
        let future = 1_795_609_085_500.0 + 10 * 60 * 1000
        let data = try ContractFixture.patched("myRun.ready", "run.lastPosition.capturedAtMs", future)
        guard case let .ready(_, _, run, _) = try runSnapshot(data: data) else { return XCTFail("expected ready") }
        XCTAssertNil(run.position)
    }

    func testNegativeAccuracyIsRejected() throws {
        let data = try ContractFixture.patched("myRun.ready", "run.lastPosition.horizontalAccuracyM", -1.0)
        guard case let .ready(_, _, run, _) = try runSnapshot(data: data) else { return XCTFail("expected ready") }
        XCTAssertNil(run.position)
    }

    func testFractionalRevisionIsAnError() throws {
        let data = try ContractFixture.patched("myRun.ready", "run.liveRevision", 1.5)
        XCTAssertThrowsError(try runSnapshot(data: data)) {
            XCTAssertEqual($0 as? MappingError, .invalidField("run.liveRevision"))
        }
    }

    func testUnknownRunStateIsAnError() throws {
        let data = try ContractFixture.patched("myRun.ready", "run.state", "paused")
        XCTAssertThrowsError(try runSnapshot(data: data))
    }

    func testUnsupportedSchemaVersionIsAnError() throws {
        let data = try ContractFixture.patched("myRun.noActiveRun", "schemaVersion", 2)
        XCTAssertThrowsError(try runSnapshot(data: data)) {
            XCTAssertEqual($0 as? MappingError, .unsupportedSchemaVersion(2))
        }
    }

    func testUnknownStatusFailsToDecode() throws {
        let data = try ContractFixture.patched("myRun.noActiveRun", "status", "maybe")
        XCTAssertThrowsError(try JSONDecoder().decode(MyRunDTO.self, from: data))
    }

    func testConvexSpecialFloatEncodingDecodes() throws {
        // Convex sends non-finite floats as {"$float": base64 little-endian}; NaN must not become a marker.
        var nan = Double.nan
        let encoded = Data(bytes: &nan, count: MemoryLayout<Double>.size).base64EncodedString()
        let data = try ContractFixture.patched("myRun.ready", "run.lastPosition.latitude", ["$float": encoded])
        guard case let .ready(_, _, run, _) = try runSnapshot(data: data) else { return XCTFail("expected ready") }
        XCTAssertNil(run.position)
    }
}
