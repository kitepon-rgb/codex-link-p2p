// iPhone 側 WebRTC PeerConnection (offerer 固定).
//
// stasel/WebRTC (Google WebRTC.framework wrap) を使う. iOS と macOS 両対応の
// XCFramework なので `swift test` でもリンクできる.
//
// 役割:
// - RTCPeerConnection を作成 (ICE servers は signaling 経由で取得した STUN /
//   TURN credential を都度注入)
// - DataChannel "codex-link-session" を **iPhone が作る** (offerer = creator).
// - offer を生成 → signaling 経由で Host へ送る
// - Host からの answer / ICE candidate を受けて peer に渡す
// - DataChannel が open になったら delegate に通知し、open 中は
//   CodexLinkSessionFrame を text 経由で双方向通信する
// - 接続経路 (host / srflx / relay) を candidate pair から導出

import Foundation
import OSLog
import WebRTC

private let log = Logger(subsystem: "dev.codexlink", category: "peer")

private func pcDiag(_ msg: String) {
    NSLog("[codex-link] %@", msg)
    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
    guard let path = docs?.appendingPathComponent("codex-link-debug.log") else { return }
    let line = "\(Date().ISO8601Format()) [pc] \(msg)\n"
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
}

public let kCodexLinkDataChannelLabel = "codex-link-session"

public enum PeerConnectionPath: Sendable {
    case connecting
    case direct
    case stunReflexive
    case turnRelayed
    case failed
}

public protocol PeerConnectionDelegate: AnyObject, Sendable {
    func peer(_ peer: PeerConnection, didGenerateLocalSignal signal: RtcSignal)
    func peer(_ peer: PeerConnection, didChangeState state: RtcConnectionState)
    func peer(_ peer: PeerConnection, didChangePath path: PeerConnectionPath)
    func peer(_ peer: PeerConnection, didOpenDataChannel: Void)
    func peer(_ peer: PeerConnection, didReceiveFrame frame: CodexLinkSessionFrame)
    func peer(_ peer: PeerConnection, didReportError error: Error)
}

public final class PeerConnection: NSObject, @unchecked Sendable {

    public weak var delegate: PeerConnectionDelegate?

    private let factory: RTCPeerConnectionFactory
    private var pc: RTCPeerConnection?
    private var dataChannel: RTCDataChannel?
    private var iceServers: [RTCIceServer] = []
    private var dcDelegate: DataChannelDelegate?
    private var pathPollTimer: Timer?
    private var lastReportedPath: PeerConnectionPath = .connecting

    public override init() {
        RTCInitializeSSL()
        let encoderFactory = RTCDefaultVideoEncoderFactory()
        let decoderFactory = RTCDefaultVideoDecoderFactory()
        self.factory = RTCPeerConnectionFactory(
            encoderFactory: encoderFactory,
            decoderFactory: decoderFactory
        )
        super.init()
    }

    deinit {
        pathPollTimer?.invalidate()
        pc?.close()
    }

    /// `RTCPeerConnection.statistics(...)` を 2s 周期で取って selected candidate
    /// pair の type から経路を導出する. ICE state 変化 1 回だけだと nominated
    /// 確定タイミングを取りこぼすので、明示的な polling にする.
    /// (BOOTSTRAP.md は 5s 周期と言っていたが、UI 反応速度のため短めにした)
    private func startPathPolling() {
        pathPollTimer?.invalidate()
        let timer = Timer(timeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.pollPath()
        }
        RunLoop.main.add(timer, forMode: .common)
        self.pathPollTimer = timer
    }

    private func pollPath() {
        guard let pc = pc else { return }
        pc.statistics { [weak self] report in
            guard let self = self else { return }
            let path = self.derivePath(from: report)
            // 同じ値の連投は抑える (UI 側 @Published の不必要な発火を防ぐ).
            if path != self.lastReportedPath {
                self.lastReportedPath = path
                self.delegate?.peer(self, didChangePath: path)
            }
        }
    }

    public func setIceServers(stunUrls: [String], turn: TurnCredential?) {
        var servers: [RTCIceServer] = []
        servers.append(RTCIceServer(urlStrings: stunUrls))
        if let turn = turn {
            servers.append(
                RTCIceServer(
                    urlStrings: turn.urls,
                    username: turn.username,
                    credential: turn.password
                )
            )
        }
        self.iceServers = servers
    }

    // ===== Offerer lifecycle =====

    public func startOffer() {
        pcDiag("startOffer: building RTCPeerConnection with \(iceServers.count) ice servers")
        let config = RTCConfiguration()
        config.iceServers = iceServers
        config.sdpSemantics = .unifiedPlan
        config.continualGatheringPolicy = .gatherContinually

        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let pc = factory.peerConnection(with: config, constraints: constraints, delegate: self) else {
            pcDiag("factory.peerConnection returned nil")
            delegate?.peer(self, didReportError: PeerError.factoryFailed)
            return
        }
        pcDiag("RTCPeerConnection created")
        self.pc = pc
        startPathPolling()

        // DataChannel を作る (offerer 側で作成).
        let dcConfig = RTCDataChannelConfiguration()
        dcConfig.isOrdered = true
        if let dc = pc.dataChannel(forLabel: kCodexLinkDataChannelLabel, configuration: dcConfig) {
            let dcDel = DataChannelDelegate(parent: self)
            dc.delegate = dcDel
            self.dataChannel = dc
            self.dcDelegate = dcDel
        }

        // offer 生成.
        pcDiag("calling pc.offer()")
        pc.offer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { [weak self] sdp, err in
            guard let self = self else { return }
            if let err = err {
                pcDiag("pc.offer error: \(err.localizedDescription)")
                self.delegate?.peer(self, didReportError: err)
                return
            }
            guard let sdp = sdp else {
                pcDiag("pc.offer returned nil sdp")
                return
            }
            pcDiag("pc.offer succeeded, sdp len=\(sdp.sdp.count); calling setLocalDescription")
            pc.setLocalDescription(sdp) { [weak self] err in
                guard let self = self else { return }
                if let err = err {
                    pcDiag("setLocalDescription error: \(err.localizedDescription)")
                    self.delegate?.peer(self, didReportError: err)
                    return
                }
                pcDiag("setLocalDescription ok; sending offer via signaling")
                let sdpBase64 = Data(sdp.sdp.utf8).base64EncodedString()
                self.delegate?.peer(self, didGenerateLocalSignal: .offer(sdpBase64: sdpBase64))
            }
        }
    }

    public func applyHostSignal(_ signal: RtcSignal) {
        guard let pc = pc else { return }
        switch signal {
        case .answer(let sdpBase64):
            guard let raw = Data(base64Encoded: sdpBase64),
                  let sdp = String(data: raw, encoding: .utf8) else { return }
            let desc = RTCSessionDescription(type: .answer, sdp: sdp)
            pc.setRemoteDescription(desc) { [weak self] err in
                if let err = err { self?.delegate?.peer(self!, didReportError: err) }
            }
        case .ice(let candBase64, let mid, let line):
            guard let raw = Data(base64Encoded: candBase64),
                  let candStr = String(data: raw, encoding: .utf8) else { return }
            let cand = RTCIceCandidate(
                sdp: candStr,
                sdpMLineIndex: Int32(line ?? 0),
                sdpMid: mid
            )
            pc.add(cand) { [weak self] err in
                if let err = err { self?.delegate?.peer(self!, didReportError: err) }
            }
        case .offer:
            // iPhone は offerer 固定なので host から offer は来ない. 来ても無視.
            break
        case .connectionState:
            // status 通知. UI 反映に使う場合は別経路.
            break
        }
    }

    public func send(_ frame: CodexLinkSessionFrame) {
        guard let dc = dataChannel else { return }
        guard dc.readyState == .open else { return }
        guard let data = try? JSONEncoder().encode(frame) else { return }
        // text frame として送る (Host 側も text を JSON.parse する).
        let buf = RTCDataBuffer(data: data, isBinary: false)
        dc.sendData(buf)
    }

    public func close() {
        pathPollTimer?.invalidate()
        pathPollTimer = nil
        dataChannel?.close()
        dataChannel = nil
        dcDelegate = nil
        pc?.close()
        pc = nil
    }

    public enum PeerError: Error {
        case factoryFailed
    }

    // ===== DataChannel delegate forwarder =====
    fileprivate func handleDataChannelOpen() {
        NSLog("[codex-link] dc_open")
        delegate?.peer(self, didOpenDataChannel: ())
    }

    fileprivate func handleDataChannelMessage(_ buf: RTCDataBuffer) {
        // text/binary 両対応で JSON.parse する.
        guard let frame = try? JSONDecoder().decode(CodexLinkSessionFrame.self, from: buf.data) else {
            return
        }
        delegate?.peer(self, didReceiveFrame: frame)
    }
}

// ===== RTCPeerConnectionDelegate =====

extension PeerConnection: RTCPeerConnectionDelegate {

    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}

    public func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    public func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    public func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}

    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        let mapped: RtcConnectionState
        switch newState {
        case .new: mapped = .new
        case .checking: mapped = .checking
        case .connected: mapped = .connected
        case .completed: mapped = .completed
        case .failed: mapped = .failed
        case .disconnected: mapped = .disconnected
        case .closed: mapped = .closed
        case .count: mapped = .new
        @unknown default: mapped = .new
        }
        NSLog("[codex-link] ice_state: %@", String(describing: mapped))
        delegate?.peer(self, didChangeState: mapped)

        // selected candidate pair から path を導出.
        peerConnection.statistics { [weak self] report in
            guard let self = self else { return }
            self.delegate?.peer(self, didChangePath: self.derivePath(from: report))
        }
    }

    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}

    public func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        let base64 = Data(candidate.sdp.utf8).base64EncodedString()
        delegate?.peer(self, didGenerateLocalSignal: .ice(
            candidateBase64: base64,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: Int(candidate.sdpMLineIndex)
        ))
    }

    public func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

    public func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        // iPhone は offerer なので通常はこの delegate は来ない. ただし Host が
        // 別 channel を開いた場合の保険として実装.
        let dcDel = DataChannelDelegate(parent: self)
        dataChannel.delegate = dcDel
        self.dataChannel = dataChannel
        self.dcDelegate = dcDel
    }

    private func derivePath(from report: RTCStatisticsReport) -> PeerConnectionPath {
        // selected pair の candidate type を見て path を分類.
        let stats = report.statistics
        // candidate-pair の selected 判定. iOS の libwebrtc 版は selected pair
        // を `state == "succeeded"` AND `nominated == true` で示す.
        // `nominated` フラグ取りこぼし対策に `state == "succeeded"` も拾う.
        var selected: RTCStatistics? = nil
        var fallback: RTCStatistics? = nil
        for (_, s) in stats {
            guard s.type == "candidate-pair" else { continue }
            let state = (s.values["state"] as? String) ?? ""
            let nominated = (s.values["nominated"] as? Bool) ?? false
            if state == "succeeded" && nominated {
                selected = s
                break
            }
            if state == "succeeded" {
                fallback = s
            }
        }
        let pair = selected ?? fallback
        guard let pair = pair,
              let localId = pair.values["localCandidateId"] as? String,
              let remoteId = pair.values["remoteCandidateId"] as? String,
              let local = stats[localId],
              let remote = stats[remoteId]
        else { return .connecting }
        let localType = (local.values["candidateType"] as? String) ?? ""
        let remoteType = (remote.values["candidateType"] as? String) ?? ""
        if localType == "relay" || remoteType == "relay" { return .turnRelayed }
        if localType == "srflx" || remoteType == "srflx" { return .stunReflexive }
        if localType == "host" && remoteType == "host" { return .direct }
        return .connecting
    }
}

// ===== DataChannel delegate =====

private final class DataChannelDelegate: NSObject, RTCDataChannelDelegate, @unchecked Sendable {
    weak var parent: PeerConnection?

    init(parent: PeerConnection) {
        self.parent = parent
    }

    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        NSLog("[codex-link] dc_state: %@", String(describing: dataChannel.readyState))
        if dataChannel.readyState == .open {
            parent?.handleDataChannelOpen()
        }
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        parent?.handleDataChannelMessage(buffer)
    }
}
