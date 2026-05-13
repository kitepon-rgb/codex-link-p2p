// SignalingWebSocketClient の integration テスト.
//
// **重要**: このテストは TypeScript 側で起動した実 Relay を相手にする.
// テスト実行前に環境変数 CODEX_LINK_TEST_RELAY_URL と
// CODEX_LINK_TEST_BEARER (device session token) が設定されていなければ skip.
//
// CI で実行する場合は別途 Node プロセスで relay を立てて env を渡す. ローカル
// では通常 `swift test` 単独で skip される (Swift 側の WS 動作確認は WireCompat
// 系で代替).

import XCTest
@testable import CodexLinkIOS

final class SignalingClientIntegrationTests: XCTestCase {

    func testConnectsAndReceivesWelcomeWhenRelayProvided() throws {
        guard
            let relayStr = ProcessInfo.processInfo.environment["CODEX_LINK_TEST_RELAY_URL"],
            let bearer = ProcessInfo.processInfo.environment["CODEX_LINK_TEST_BEARER"],
            let relayUrl = URL(string: relayStr)
        else {
            // 実 Relay 無し: skip.
            throw XCTSkip("Set CODEX_LINK_TEST_RELAY_URL and CODEX_LINK_TEST_BEARER to run.")
        }

        let recorder = Recorder()
        let client = SignalingWebSocketClient(
            relayUrl: relayUrl,
            sessionToken: bearer
        )
        client.delegate = recorder
        client.start()

        let exp = XCTestExpectation(description: "welcome")
        recorder.onWelcome = { _ in
            exp.fulfill()
        }
        wait(for: [exp], timeout: 3.0)
        client.stop()
    }

    private final class Recorder: NSObject, SignalingClientDelegate, @unchecked Sendable {
        var onWelcome: ((UserId) -> Void)?

        func signalingClient(_ client: SignalingWebSocketClient, didChangeState state: SignalingClientState) {}
        func signalingClient(_ client: SignalingWebSocketClient, didReceiveWelcome userId: UserId, deviceId: DeviceId) {
            onWelcome?(userId)
        }
        func signalingClient(_ client: SignalingWebSocketClient, didReceiveHostSignal reply: HostSignalReply) {}
        func signalingClient(_ client: SignalingWebSocketClient, didReceiveTurnCredential credential: TurnCredential, hostId: HostId) {}
        func signalingClient(_ client: SignalingWebSocketClient, didReceiveError code: String, message: String, correlationType: String?) {}
    }
}
