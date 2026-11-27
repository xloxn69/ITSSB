import XCTest
@testable import ITSSB

/// Clerk's API error codes become the sign-in screen's own messages.
final class ClerkErrorMappingTests: XCTestCase {
    func testKnownCodes() {
        XCTAssertEqual(ClerkSDKBackend.authError(forCode: "form_code_incorrect"), .invalidCode)
        XCTAssertEqual(ClerkSDKBackend.authError(forCode: "verification_expired"), .codeExpired)
        XCTAssertEqual(ClerkSDKBackend.authError(forCode: "too_many_requests"), .tooManyAttempts)
        XCTAssertEqual(ClerkSDKBackend.authError(forCode: "form_param_format_invalid"), .invalidEmail)
        XCTAssertEqual(ClerkSDKBackend.authError(forCode: "something_new"), .failed)
    }

    func testTransportAndCancellation() {
        XCTAssertEqual(ClerkSDKBackend.authError(for: URLError(.notConnectedToInternet)), .network)
        XCTAssertEqual(ClerkSDKBackend.authError(for: NSError(domain: "x", code: 1)), .failed)
    }

    func testEveryErrorExceptCancelHasAMessage() {
        let all: [AuthError] = [.notConfigured, .invalidEmail, .invalidCode, .codeExpired, .tooManyAttempts,
                                .network, .trackingRejected, .needsMoreInfo, .failed]
        for error in all { XCTAssertNotNil(error.message, "\(error)") }
        XCTAssertNil(AuthError.cancelled.message)
    }
}
