// AppLifecycle — iPhone app の起動 / 復元 / 再接続オーケストレーション.
//
// 順序:
// 1. SignalingWebSocketClient.start()
// 2. welcome 受領 → TURN credential 要求
// 3. credential 受領 → PeerConnection.setIceServers + startOffer
// 4. offer 生成 → signaling.sendSignalToHost(offer)
// 5. signaling 経由で answer 到達 → peer.applyHostSignal(answer)
// 6. ICE candidate 双方向交換
// 7. DataChannel open → SessionSnapshotRequest を送り projection を更新
// 8. 以降は event → SessionProjection.applyEvent

import Foundation

/// Diagnostics: framework code writes to the same file as app's diag().
/// Path = Documents/codex-link-debug.log.
///
/// DEBUG ビルド時のみ動作する. Release では no-op になり NSLog も file writer も
/// 走らない. 実機の本番診断は Console.app 経由 (os_log) に任せる.
private func fwDiag(_ msg: String) {
    #if DEBUG
    NSLog("[codex-link] %@", msg)
    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
    guard let path = docs?.appendingPathComponent("codex-link-debug.log") else { return }
    let line = "\(Date().ISO8601Format()) [fw] \(msg)\n"
    guard let data = line.data(using: .utf8) else { return }
    if FileManager.default.fileExists(atPath: path.path) {
        if let h = try? FileHandle(forWritingTo: path) {
            defer { try? h.close() }
            _ = try? h.seekToEnd()
            try? h.write(contentsOf: data)
        }
    } else {
        try? data.write(to: path)
    }
    #endif
}

@MainActor
public final class AppLifecycle: ObservableObject {

    public enum Phase: Sendable, Equatable {
        case idle
        case signalingConnecting
        case signalingOpen
        case awaitingTurnCredential
        case peerOffering
        case peerConnecting
        case peerOpen
        case error(message: String)
    }

    @Published public private(set) var phase: Phase = .idle
    @Published public private(set) var connectionPath: PeerConnectionPath = .connecting
    public let projection = SessionProjection()

    public let hostId: HostId
    public let stunUrls: [String]
    public let signaling: SignalingWebSocketClient
    public let peer: PeerConnection

    private let userId: UserId
    private let deviceId: DeviceId

    public init(
        relayUrl: URL,
        sessionToken: String,
        userId: UserId,
        deviceId: DeviceId,
        hostId: HostId,
        stunUrls: [String] = ["stun:stun.l.google.com:19302"]
    ) {
        self.hostId = hostId
        self.stunUrls = stunUrls
        self.userId = userId
        self.deviceId = deviceId
        self.signaling = SignalingWebSocketClient(
            relayUrl: relayUrl,
            sessionToken: sessionToken
        )
        self.peer = PeerConnection()
        self.signaling.delegate = self
        self.peer.delegate = self
    }

    public func start() {
        fwDiag("AppLifecycle.start() called")
        phase = .signalingConnecting
        signaling.start()
        fwDiag("AppLifecycle.start() returning")
    }

    public func stop() {
        peer.close()
        signaling.stop()
        phase = .idle
    }

    public func submitTurn(threadId: ThreadId, input: String) {
        peer.send(.uiAction(.submitTurn(threadId: threadId, input: input)))
    }

    public func respondApproval(_ decision: ApprovalDecision) {
        peer.send(.uiAction(.respondApproval(decision: decision)))
    }

    public func requestSnapshot() {
        peer.send(.snapshotRequest(SessionSnapshotRequest(
            fromUserId: userId, fromDeviceId: deviceId,
            hostId: hostId, lastSequence: projection.latestSequence
        )))
    }
}

// MARK: - SignalingClientDelegate

extension AppLifecycle: SignalingClientDelegate {

    nonisolated public func signalingClient(_ client: SignalingWebSocketClient, didChangeState state: SignalingClientState) {
        fwDiag("signalingClient didChangeState: \(state)")
        Task { @MainActor in
            switch state {
            case .open:
                self.phase = .signalingOpen
                fwDiag("requesting TURN credential for hostId=\(self.hostId.rawValue.prefix(20))")
                client.requestTurnCredential(hostId: self.hostId)
                self.phase = .awaitingTurnCredential
            case .connecting, .reconnecting:
                self.phase = .signalingConnecting
            case .closed, .idle:
                break
            }
        }
    }

    nonisolated public func signalingClient(_ client: SignalingWebSocketClient, didReceiveWelcome userId: UserId, deviceId: DeviceId) {
        fwDiag("signalingClient didReceiveWelcome userId=\(userId.rawValue.prefix(20))")
    }

    nonisolated public func signalingClient(_ client: SignalingWebSocketClient, didReceiveError code: String, message: String, correlationType: String?) {
        fwDiag("signalingClient didReceiveError code=\(code) message=\(message)")
        Task { @MainActor in
            self.phase = .error(message: "\(code): \(message)")
        }
    }

    nonisolated public func signalingClient(_ client: SignalingWebSocketClient, didReceiveTurnCredential credential: TurnCredential, hostId: HostId) {
        fwDiag("signalingClient didReceiveTurnCredential urls=\(credential.urls.joined(separator: ","))")
        Task { @MainActor in
            fwDiag("setting ICE servers and calling peer.startOffer()")
            self.peer.setIceServers(stunUrls: self.stunUrls, turn: credential)
            self.phase = .peerOffering
            self.peer.startOffer()
            fwDiag("peer.startOffer() returned")
        }
    }

    nonisolated public func signalingClient(_ client: SignalingWebSocketClient, didReceiveHostSignal reply: HostSignalReply) {
        Task { @MainActor in
            self.peer.applyHostSignal(reply.signal)
            // phase を後退させない. ICE candidate trickling 中も .peerOpen に
            // 到達済みなら維持する (Mac Host から ICE 候補が断続的に届くたびに
            // .peerConnecting に巻き戻していたバグの修正).
            switch self.phase {
            case .peerOffering:
                self.phase = .peerConnecting
            default:
                break
            }
        }
    }

}

// MARK: - PeerConnectionDelegate

extension AppLifecycle: PeerConnectionDelegate {

    nonisolated public func peer(_ peer: PeerConnection, didGenerateLocalSignal signal: RtcSignal) {
        fwDiag("peer didGenerateLocalSignal: \(signal)")
        // offer / ICE candidate を signaling 経由で Host に流す.
        self.signaling.sendSignalToHost(hostId: self.hostId, signal: signal)
    }

    nonisolated public func peer(_ peer: PeerConnection, didChangeState state: RtcConnectionState) {
        fwDiag("peer didChangeState: \(state)")
        Task { @MainActor in
            switch state {
            case .connected, .completed:
                fwDiag("setting phase=.peerOpen (from peer state)")
                self.phase = .peerOpen
            case .failed:
                self.phase = .error(message: "peer ICE failed")
            default:
                break
            }
        }
    }

    nonisolated public func peer(_ peer: PeerConnection, didChangePath path: PeerConnectionPath) {
        fwDiag("peer didChangePath: \(path)")
        Task { @MainActor in
            self.connectionPath = path
        }
    }

    nonisolated public func peer(_ peer: PeerConnection, didOpenDataChannel: Void) {
        fwDiag("peer didOpenDataChannel received")
        Task { @MainActor in
            fwDiag("setting phase=.peerOpen (from dc_open)")
            self.phase = .peerOpen
            self.requestSnapshot()
        }
    }

    nonisolated public func peer(_ peer: PeerConnection, didReceiveFrame frame: CodexLinkSessionFrame) {
        Task { @MainActor in
            self.projection.apply(frame)
        }
    }

    nonisolated public func peer(_ peer: PeerConnection, didReportError error: Error) {
        fwDiag("peer didReportError: \(error.localizedDescription)")
        Task { @MainActor in
            self.phase = .error(message: error.localizedDescription)
        }
    }
}
