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

/// Diagnostics: PeerConnection 内部状態を Documents/codex-link-debug.log にも追記.
///
/// DEBUG ビルド時のみ動作する. Release では no-op になり NSLog も file writer も
/// 走らない. 実機の本番診断は Console.app 経由 (os_log via `log`) に任せる.
private func pcDiag(_ msg: String) {
    #if DEBUG
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
    #endif
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
    /// derivePath() で stats が想定形式と違って path 解決できなかった時、
    /// 1 回だけ stats の type 集計を pcDiag に吐く. DEBUG-only な診断手段.
    fileprivate var statsDumpedOnce = false

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
        guard let dc = dataChannel else {
            pcDiag("send: NO dataChannel (frame dropped)")
            return
        }
        guard dc.readyState == .open else {
            pcDiag("send: dc not open (state=\(dc.readyState.rawValue), frame dropped)")
            return
        }
        guard let data = try? JSONEncoder().encode(frame) else {
            pcDiag("send: JSONEncoder failed (frame dropped)")
            return
        }
        let preview = String(data: data.prefix(120), encoding: .utf8) ?? "<binary>"
        pcDiag("send (\(data.count) bytes): \(preview)")
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
        pcDiag("dc_open")
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
        pcDiag("ice_state: \(String(describing: mapped))")
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
        let stats = report.statistics

        // 1st choice: W3C 標準. transport エントリの selectedCandidatePairId が
        //              実際に使われている candidate-pair を直接指す.
        // 2nd choice: candidate-pair を scan して state="succeeded" を拾う
        //              (transport が無い古い実装向け fallback).
        let pair: RTCStatistics? = {
            for (_, s) in stats where s.type == "transport" {
                if let pairId = s.values["selectedCandidatePairId"] as? String,
                   let p = stats[pairId] {
                    return p
                }
            }
            var succeeded: RTCStatistics? = nil
            var nominated: RTCStatistics? = nil
            for (_, s) in stats where s.type == "candidate-pair" {
                let state = (s.values["state"] as? String)?.lowercased() ?? ""
                guard state == "succeeded" else { continue }
                let nom = (s.values["nominated"] as? Bool)
                    ?? ((s.values["nominated"] as? NSNumber)?.boolValue ?? false)
                if nom { nominated = s; break }
                succeeded = succeeded ?? s
            }
            return nominated ?? succeeded
        }()

        guard let pair = pair,
              let localId = pair.values["localCandidateId"] as? String,
              let remoteId = pair.values["remoteCandidateId"] as? String,
              let local = stats[localId],
              let remote = stats[remoteId]
        else {
            dumpStatsSummaryOnce(stats, reason: "no-pair-or-candidate")
            return .connecting
        }
        let localType = (local.values["candidateType"] as? String) ?? ""
        let remoteType = (remote.values["candidateType"] as? String) ?? ""
        // relay は TURN 経由なので「中継」.
        if localType == "relay" || remoteType == "relay" { return .turnRelayed }
        // srflx (STUN reflexive) / prflx (peer reflexive) はどちらも NAT 越えの
        // P2P 直結. ユーザーから見ると「直結 (NAT越え)」.
        // prflx は片側が STUN advertise していない経路 (ホスト同士の hairpin
        // やフレッシュな relay-less NAT 経由) で出る.
        let reflexive: Set<String> = ["srflx", "prflx"]
        if reflexive.contains(localType) || reflexive.contains(remoteType) {
            return .stunReflexive
        }
        if localType == "host" && remoteType == "host" { return .direct }
        // ここに来るのは type が空文字 / 未知 (例: framework が candidateType を
        // 報告しない実装). 既に candidate-pair が succeeded で nominated されて
        // いるなら直結扱いにする (Mac 側 peer.ts も同様の fallback).
        let pairState = (pair.values["state"] as? String)?.lowercased() ?? ""
        if pairState == "succeeded" {
            dumpStatsSummaryOnce(
                stats,
                reason: "succeeded-but-unknown-types local=\(localType) remote=\(remoteType)"
            )
            return .direct
        }
        dumpStatsSummaryOnce(
            stats,
            reason: "unknown-types local=\(localType) remote=\(remoteType) state=\(pairState)"
        )
        return .connecting
    }

    /// stats から path 判定できなかった時に 1 回だけ中身を pcDiag に吐く.
    /// 別な framework / 別な stats 形式に遭遇した時の手がかり.
    /// DEBUG ビルドの pcDiag 経由なので Release では no-op.
    private func dumpStatsSummaryOnce(_ stats: [String: RTCStatistics], reason: String) {
        if statsDumpedOnce { return }
        statsDumpedOnce = true
        var counts: [String: Int] = [:]
        for (_, s) in stats { counts[s.type, default: 0] += 1 }
        pcDiag("derivePath_dump reason=\(reason) types=\(counts) total=\(stats.count)")
        // 関連がありそうな type の中身を全部吐く.
        for (_, s) in stats {
            let t = s.type
            if t == "transport" || t.contains("candidate-pair") || t.contains("candidate") {
                pcDiag("derivePath_entry type=\(t) values=\(s.values)")
            }
        }
    }
}

// ===== DataChannel delegate =====

private final class DataChannelDelegate: NSObject, RTCDataChannelDelegate, @unchecked Sendable {
    weak var parent: PeerConnection?

    init(parent: PeerConnection) {
        self.parent = parent
    }

    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        pcDiag("dc_state: \(String(describing: dataChannel.readyState))")
        if dataChannel.readyState == .open {
            parent?.handleDataChannelOpen()
        }
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        parent?.handleDataChannelMessage(buffer)
    }
}
