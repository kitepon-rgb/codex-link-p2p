import XCTest
@testable import CodexLinkIOS

final class IdentifierTests: XCTestCase {
    func testBrandedIdsRejectEmpty() {
        XCTAssertNil(UserId(rawValue: ""))
        XCTAssertNil(DeviceId(rawValue: ""))
        XCTAssertNil(HostId(rawValue: ""))
        XCTAssertNil(ThreadId(rawValue: ""))
        XCTAssertNil(RequestId(rawValue: ""))
    }

    func testBrandedIdsAcceptNonEmpty() {
        XCTAssertEqual(UserId("usr_a").rawValue, "usr_a")
        XCTAssertEqual(DeviceId("dev_a").rawValue, "dev_a")
        XCTAssertEqual(HostId("hst_a").rawValue, "hst_a")
    }

    func testJsonRoundTripForUserId() throws {
        let original = UserId("usr_round")
        let data = try JSONEncoder().encode(original)
        XCTAssertEqual(String(data: data, encoding: .utf8), "\"usr_round\"")
        let back = try JSONDecoder().decode(UserId.self, from: data)
        XCTAssertEqual(back, original)
    }

    func testSequenceNumberOrdering() {
        XCTAssertTrue(SequenceNumber(1) < SequenceNumber(2))
        XCTAssertFalse(SequenceNumber(2) < SequenceNumber(2))
    }
}
