import XCTest
@testable import CodexLinkIOS

final class CodexLinkIOSTests: XCTestCase {
    func testVersionPlaceholder() {
        XCTAssertEqual(CodexLinkIOS.version, "0.0.0")
    }
}
