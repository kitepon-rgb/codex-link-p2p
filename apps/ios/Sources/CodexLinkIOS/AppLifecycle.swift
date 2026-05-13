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
        phase = .signalingConnecting
        signaling.start()
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
        Task { @MainActor in
            switch state {
            case .open:
                self.phase = .signalingOpen
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
        // welcome 自体は state.open で扱う. ここでは何もしない.
        _ = (userId, deviceId)
    }

    nonisolated public func signalingClient(_ client: SignalingWebSocketClient, didReceiveTurnCredential credential: TurnCredential, hostId: HostId) {
        Task { @MainActor in
            self.peer.setIceServers(stunUrls: self.stunUrls, turn: credential)
            self.phase = .peerOffering
            self.peer.startOffer()
        }
    }

    nonisolated public func signalingClient(_ client: SignalingWebSocketClient, didReceiveHostSignal reply: HostSignalReply) {
        Task { @MainActor in
            self.peer.applyHostSignal(reply.signal)
            self.phase = .peerConnecting
        }
    }

    nonisolated public func signalingClient(_ client: SignalingWebSocketClient, didReceiveError code: String, message: String, correlationType: String?) {
        Task { @MainActor in
            self.phase = .error(message: "\(code): \(message)")
        }
    }
}

// MARK: - PeerConnectionDelegate

extension AppLifecycle: PeerConnectionDelegate {

    nonisolated public func peer(_ peer: PeerConnection, didGenerateLocalSignal signal: RtcSignal) {
        // offer / ICE candidate を signaling 経由で Host に流す.
        self.signaling.sendSignalToHost(hostId: self.hostId, signal: signal)
    }

    nonisolated public func peer(_ peer: PeerConnection, didChangeState state: RtcConnectionState) {
        Task { @MainActor in
            switch state {
            case .connected, .completed:
                self.phase = .peerOpen
            case .failed:
                self.phase = .error(message: "peer ICE failed")
            default:
                break
            }
        }
    }

    nonisolated public func peer(_ peer: PeerConnection, didChangePath path: PeerConnectionPath) {
        // Phase 7 で UI バッジに反映する. 現状は phase 単独.
        _ = path
    }

    nonisolated public func peer(_ peer: PeerConnection, didOpenDataChannel: Void) {
        Task { @MainActor in
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
        Task { @MainActor in
            self.phase = .error(message: error.localizedDescription)
        }
    }
}
