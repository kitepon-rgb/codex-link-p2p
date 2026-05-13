// TypeScript 側 (relay / mac-host) で生成された JSON を Swift で decode できる
// ことを保証するテスト. 重要な protocol 互換性テスト.

import XCTest
@testable import CodexLinkIOS

final class WireCompatibilityTests: XCTestCase {

    // ===== RtcSignal =====

    func testDecodeOfferSignalFromTSJson() throws {
        let json = #"{"kind":"offer","sdpBase64":"djA9MA=="}"#.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(RtcSignal.self, from: json)
        if case .offer(let sdp) = decoded {
            XCTAssertEqual(sdp, "djA9MA==")
        } else {
            XCTFail("expected .offer")
        }
    }

    func testDecodeIceSignalWithNullableFields() throws {
        let json = #"{"kind":"ice","candidateBase64":"YQ==","sdpMid":null,"sdpMLineIndex":null}"#.data(using: .utf8)!
        let s = try JSONDecoder().decode(RtcSignal.self, from: json)
        if case .ice(_, let mid, let line) = s {
            XCTAssertNil(mid)
            XCTAssertNil(line)
        } else {
            XCTFail("expected .ice")
        }
    }

    // ===== WS Outbound =====

    func testDecodeWelcomeFromTS() throws {
        let json = #"{"type":"welcome","userId":"usr_a","deviceId":"dev_a"}"#.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(WsOutbound.self, from: json)
        if case .welcome(let u, let d) = decoded {
            XCTAssertEqual(u.rawValue, "usr_a")
            XCTAssertEqual(d.rawValue, "dev_a")
        } else {
            XCTFail("expected .welcome")
        }
    }

    func testDecodeSignalFromHostReply() throws {
        let json = """
        {"type":"signal.from_host","reply":{"fromHostId":"hst_x","toUserId":"usr_y","toDeviceId":"dev_z","signal":{"kind":"answer","sdpBase64":"YQ=="},"sentAt":1}}
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(WsOutbound.self, from: json)
        if case .signalFromHost(let r) = decoded {
            XCTAssertEqual(r.fromHostId.rawValue, "hst_x")
            XCTAssertEqual(r.toDeviceId.rawValue, "dev_z")
            if case .answer(let sdp) = r.signal {
                XCTAssertEqual(sdp, "YQ==")
            } else {
                XCTFail("expected .answer signal")
            }
        } else {
            XCTFail("expected .signalFromHost")
        }
    }

    func testDecodeTurnCredentialIssued() throws {
        let json = """
        {"type":"turn.credential.issued","credential":{"username":"123:usr_a","password":"p","ttlSec":300,"expiresAt":1700,"urls":["stun:s","turn:t"]},"hostId":"hst_a"}
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(WsOutbound.self, from: json)
        if case .turnCredentialIssued(let c, let h) = decoded {
            XCTAssertEqual(c.username, "123:usr_a")
            XCTAssertEqual(c.urls, ["stun:s", "turn:t"])
            XCTAssertEqual(h.rawValue, "hst_a")
        } else {
            XCTFail("expected .turnCredentialIssued")
        }
    }

    func testDecodeError() throws {
        let json = #"{"type":"error","code":"rate_limited","message":"too fast"}"#.data(using: .utf8)!
        let d = try JSONDecoder().decode(WsOutbound.self, from: json)
        if case .error(let code, let msg, _) = d {
            XCTAssertEqual(code, "rate_limited")
            XCTAssertEqual(msg, "too fast")
        } else {
            XCTFail("expected .error")
        }
    }

    // ===== WS Inbound encode (Swift → TS) =====

    func testEncodeSignalToHostMatchesTSWire() throws {
        let msg = WsInbound.signalToHost(
            hostId: HostId("hst_z"),
            signal: .offer(sdpBase64: "djA9MA=="),
            sentAt: 1700000000
        )
        let data = try JSONEncoder().encode(msg)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["type"] as? String, "signal.to_host")
        XCTAssertEqual(obj?["hostId"] as? String, "hst_z")
        XCTAssertEqual(obj?["sentAt"] as? Int, 1700000000)
        let sig = obj?["signal"] as? [String: Any]
        XCTAssertEqual(sig?["kind"] as? String, "offer")
        XCTAssertEqual(sig?["sdpBase64"] as? String, "djA9MA==")
    }

    func testEncodeTurnCredentialRequest() throws {
        let msg = WsInbound.turnCredentialRequest(hostId: HostId("hst_w"))
        let data = try JSONEncoder().encode(msg)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["type"] as? String, "turn.credential.request")
        XCTAssertEqual(obj?["hostId"] as? String, "hst_w")
    }

    // ===== CodexLinkSessionFrame =====

    func testDecodeAssistantDeltaFrame() throws {
        let json = """
        {"kind":"event","event":{"type":"assistant.delta","sequence":3,"timestamp":1700,"threadId":"t1","delta":"hello"}}
        """.data(using: .utf8)!
        let frame = try JSONDecoder().decode(CodexLinkSessionFrame.self, from: json)
        if case .event(let e) = frame, case .assistantDelta(_, _, let tid, let delta) = e {
            XCTAssertEqual(tid.rawValue, "t1")
            XCTAssertEqual(delta, "hello")
        } else {
            XCTFail("expected event/assistantDelta")
        }
    }

    func testDecodeApprovalRequestedFrame() throws {
        let json = """
        {"kind":"event","event":{"type":"approval.requested","sequence":1,"timestamp":1,"request":{"requestId":"r1","threadId":"t1","summary":"rm","kind":"command","detail":"d"}}}
        """.data(using: .utf8)!
        let f = try JSONDecoder().decode(CodexLinkSessionFrame.self, from: json)
        if case .event(let e) = f, case .approvalRequested(_, _, let req) = e {
            XCTAssertEqual(req.kind, .command)
            XCTAssertEqual(req.summary, "rm")
        } else {
            XCTFail("expected approvalRequested")
        }
    }

    func testEncodeUIActionSubmitTurn() throws {
        let frame = CodexLinkSessionFrame.uiAction(
            .submitTurn(threadId: ThreadId("t1"), input: "do thing")
        )
        let data = try JSONEncoder().encode(frame)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["kind"] as? String, "ui_action")
        let action = obj?["action"] as? [String: Any]
        XCTAssertEqual(action?["type"] as? String, "ui.submit_turn")
        XCTAssertEqual(action?["threadId"] as? String, "t1")
        XCTAssertEqual(action?["input"] as? String, "do thing")
    }

    func testSnapshotRequestRoundTrip() throws {
        let req = SessionSnapshotRequest(
            fromUserId: UserId("u"), fromDeviceId: DeviceId("d"),
            hostId: HostId("h"), lastSequence: SequenceNumber(5)
        )
        let data = try JSONEncoder().encode(req)
        let back = try JSONDecoder().decode(SessionSnapshotRequest.self, from: data)
        XCTAssertEqual(back, req)
    }
}
