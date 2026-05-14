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

    #if os(iOS) && canImport(ActivityKit)
    @available(iOS 17.0, *)
    private static let liveActivityController = CodexLinkLiveActivityController()
    #endif
    /// 現在表示中のスレッド / ターン. AppLifecycle が ChangedEvent を受け取る
    /// たびに更新し、Live Activity に渡す.
    public private(set) var liveActivitySelection: CodexLinkSessionSelection = CodexLinkSessionSelection()
    /// Live Activity の sync を rate-limit するための debounce timer.
    /// 連続 streaming delta で ActivityKit に高頻度 update を投げない.
    private var liveActivityDebounceTask: Task<Void, Never>?
    /// 最後に sync を投げた時刻 (Live Activity update の rate limit 用).
    private var lastLiveActivitySyncAt: Date = Date.distantPast
    /// peer state が .failed に入った時刻. .failed が 10s 続いたら自動再接続.
    fileprivate var failedSince: Date?
    fileprivate var failedAutoReconnectTask: Task<Void, Never>?

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
        self.liveActivitySelection.hostId = hostId
        self.signaling = SignalingWebSocketClient(
            relayUrl: relayUrl,
            sessionToken: sessionToken
        )
        self.peer = PeerConnection()
        self.signaling.delegate = self
        self.peer.delegate = self
    }

    /// 外部 (CodexLinkRootView) から現在 UI 上で見ているスレッド / ターンを
    /// セットする. Live Activity の visibility / deep link target に使う.
    public func updateLiveActivitySelection(
        projectId: ProjectId?,
        threadId: ThreadId?,
        activeTurnId: TurnId?
    ) {
        liveActivitySelection.projectId = projectId
        liveActivitySelection.threadId = threadId
        liveActivitySelection.activeTurnId = activeTurnId
        syncLiveActivity()
    }

    /// Live Activity の sync は 500ms ごとに 1 回まで. streaming delta 等で
    /// 連続 event が来ても、最後の event の 500ms 後に 1 回だけ ActivityKit に
    /// update を投げる. これで Live Activity の rate limit に引っかからず、
    /// CPU / battery にも優しい.
    private func syncLiveActivity() {
        #if os(iOS) && canImport(ActivityKit)
        if #available(iOS 17.0, *) {
            liveActivityDebounceTask?.cancel()
            liveActivityDebounceTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 500_000_000) // 500ms
                guard let self = self, !Task.isCancelled else { return }
                self.lastLiveActivitySyncAt = Date()
                let state = self.projection.state
                let selection = self.liveActivitySelection
                Task.detached(priority: .background) {
                    do {
                        _ = try await Self.liveActivityController.sync(state: state, selection: selection)
                    } catch {
                        // ActivityKit エラーは UI に出さない (権限 OFF など)
                    }
                }
            }
        }
        #endif
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

    /// background → foreground 復帰時に呼ぶ. signaling WS が closed / dead で
    /// あれば再接続を仕掛ける. ContentView の .onChange(of: scenePhase) から
    /// 呼ぶ想定.
    public func resumeIfNeeded() {
        let needsResume: Bool
        switch phase {
        case .idle, .error:
            needsResume = true
        case .signalingConnecting, .signalingOpen, .awaitingTurnCredential,
             .peerOffering, .peerConnecting, .peerOpen:
            // signaling client が closed なら再接続必要.
            needsResume = signaling.currentState == .closed || signaling.currentState == .idle
        }
        guard needsResume else { return }
        reconnect(reason: "resumeIfNeeded(phase=\(phase))")
    }

    /// 強制的に signaling + peer を貼り直す. Settings の Reconnect ボタンや
    /// 自動再接続タイマから呼ぶ.
    public func reconnect(reason: String) {
        fwDiag("reconnect: \(reason)")
        peer.close()
        signaling.stop()
        // 少し遅延を入れて WS 完全 close 後に start (race condition 回避).
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 200_000_000)
            self.phase = .signalingConnecting
            self.signaling.start()
        }
    }

    public func submitTurn(projectId: ProjectId, threadId: ThreadId?, input: String) {
        peer.send(.uiAction(.submitTurn(projectId: projectId, threadId: threadId, input: input)))
    }

    public func respondApproval(_ decision: ApprovalDecision) {
        peer.send(.uiAction(.respondApproval(decision: decision)))
    }

    public func cancelTurn(threadId: ThreadId, turnId: TurnId) {
        peer.send(.uiAction(.cancelTurn(threadId: threadId, turnId: turnId)))
    }

    public func resumeThread(threadId: ThreadId) {
        peer.send(.uiAction(.resumeThread(threadId: threadId)))
    }

    public func requestSnapshot() {
        peer.send(.snapshotRequest(SessionSnapshotRequest(
            fromUserId: userId, fromDeviceId: deviceId,
            hostId: hostId, lastSequence: projection.state.latestSequence
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
                self.failedSince = nil
            case .failed:
                self.phase = .error(message: "peer ICE failed")
                self.failedSince = Date()
                self.scheduleFailedAutoReconnect()
            default:
                self.failedSince = nil
            }
        }
    }

    /// peer state が .failed のまま 10s 続いたら自動再接続する. ユーザが
    /// Settings の Reconnect ボタンを押す前に勝手に直す.
    private func scheduleFailedAutoReconnect() {
        failedAutoReconnectTask?.cancel()
        failedAutoReconnectTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 10_000_000_000) // 10s
            guard let self = self, !Task.isCancelled else { return }
            guard self.failedSince != nil else { return }
            self.reconnect(reason: "peer .failed 10s 経過の自動再接続")
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
            switch frame {
            case .event(_, _, let event):
                self.projection.apply(event)
                self.updateSelectionFromEvent(event)
            case .snapshotResponse(let response):
                self.projection.applySnapshot(response.projection)
                self.syncLiveActivity()
            case .uiAction, .snapshotRequest, .ack:
                break
            }
        }
    }

    /// イベントから自動的に selection (= Live Activity の対象 thread/turn) を
    /// 更新する. ユーザーが手動で thread 切替した場合は updateLiveActivitySelection()
    /// で上書きできる.
    private func updateSelectionFromEvent(_ event: CodexLinkEvent) {
        switch event {
        case .threadStarted(let thread):
            liveActivitySelection.projectId = thread.projectId
            liveActivitySelection.threadId = thread.id
            liveActivitySelection.activeTurnId = nil
            syncLiveActivity()
        case .turnStatusChanged(let threadId, let turnId, _):
            if liveActivitySelection.threadId == threadId {
                liveActivitySelection.activeTurnId = turnId
            }
            syncLiveActivity()
        case .approvalRequested, .approvalResolved, .assistantDelta, .assistantFinal,
             .timelineItemStarted, .timelineItemCompleted, .transcriptItemRecorded:
            syncLiveActivity()
        default:
            break
        }
    }

    nonisolated public func peer(_ peer: PeerConnection, didReportError error: Error) {
        fwDiag("peer didReportError: \(error.localizedDescription)")
        Task { @MainActor in
            self.phase = .error(message: error.localizedDescription)
        }
    }
}
