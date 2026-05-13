// Relay へ WSS で signaling だけ流す client.
//
// 役割:
// - URLSession の WebSocket task で Relay に接続
// - Authorization: Bearer <sessionToken> ヘッダで認証
// - 受信: welcome / signal.from_host / turn.credential.issued / error
// - 送信: signal.to_host (offer / ICE) / turn.credential.request
// - 自動再接続 (指数バックオフ)
//
// **broker 経路 (host.event / client.toHost 等) を一切扱わない**. iOS 側でも
// 鉄則を守る.

import Foundation

private func sigClientLog(_ msg: String) {
    NSLog("[codex-link] %@", msg)
    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
    guard let path = docs?.appendingPathComponent("codex-link-debug.log") else { return }
    let line = "\(Date().ISO8601Format()) [sig] \(msg)\n"
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

public enum SignalingClientState: Sendable {
    case idle, connecting, open, reconnecting, closed
}

public protocol SignalingClientDelegate: AnyObject, Sendable {
    func signalingClient(_ client: SignalingWebSocketClient, didChangeState state: SignalingClientState)
    func signalingClient(_ client: SignalingWebSocketClient, didReceiveWelcome userId: UserId, deviceId: DeviceId)
    func signalingClient(_ client: SignalingWebSocketClient, didReceiveHostSignal reply: HostSignalReply)
    func signalingClient(_ client: SignalingWebSocketClient, didReceiveTurnCredential credential: TurnCredential, hostId: HostId)
    func signalingClient(_ client: SignalingWebSocketClient, didReceiveError code: String, message: String, correlationType: String?)
}

public final class SignalingWebSocketClient: NSObject, @unchecked Sendable {
    public weak var delegate: SignalingClientDelegate?

    private let relayUrl: URL
    private let sessionToken: String
    private let session: URLSession
    private var task: URLSessionWebSocketTask?
    private var state: SignalingClientState = .idle
    private var intentionallyClosed = false
    private var reconnectAttempts = 0
    private let reconnectMinMs: Int
    private let reconnectMaxMs: Int
    private let queue: DispatchQueue
    // Pending sends — open まで貯めて open 直後に flush.
    private var pendingSends: [Data] = []

    public init(
        relayUrl: URL,
        sessionToken: String,
        urlSession: URLSession = .shared,
        reconnectMinMs: Int = 500,
        reconnectMaxMs: Int = 15_000,
        queue: DispatchQueue = .global(qos: .userInitiated)
    ) {
        self.relayUrl = relayUrl
        self.sessionToken = sessionToken
        self.session = urlSession
        self.reconnectMinMs = reconnectMinMs
        self.reconnectMaxMs = reconnectMaxMs
        self.queue = queue
    }

    public var currentState: SignalingClientState { state }

    public func start() {
        NSLog("[codex-link] SignalingClient.start() called, relayUrl=%@", relayUrl.absoluteString)
        queue.async { [weak self] in
            guard let self = self else { return }
            guard self.state == .idle || self.state == .closed else {
                NSLog("[codex-link] start() ignored, state=%@", String(describing: self.state))
                return
            }
            self.intentionallyClosed = false
            self.connect()
        }
    }

    public func stop() {
        queue.async { [weak self] in
            guard let self = self else { return }
            self.intentionallyClosed = true
            self.task?.cancel(with: .goingAway, reason: nil)
            self.task = nil
            self.setState(.closed)
        }
    }

    // ===== Outbound API =====

    public func sendSignalToHost(hostId: HostId, signal: RtcSignal, sentAt: Int = Int(Date().timeIntervalSince1970 * 1000)) {
        send(.signalToHost(hostId: hostId, signal: signal, sentAt: sentAt))
    }

    public func requestTurnCredential(hostId: HostId) {
        send(.turnCredentialRequest(hostId: hostId))
    }

    public func send(_ message: WsInbound) {
        let encoder = JSONEncoder()
        let data: Data
        do {
            data = try encoder.encode(message)
        } catch {
            NSLog("[codex-link] send encode FAILED: %@", error.localizedDescription)
            sigClientLog("send encode FAILED: \(error.localizedDescription)")
            return
        }
        let preview = String(data: data.prefix(200), encoding: .utf8) ?? "<binary>"
        sigClientLog("send (\(data.count) bytes): \(preview)")
        queue.async { [weak self] in
            guard let self = self else { return }
            guard let task = self.task, self.state == .open else {
                sigClientLog("send queued (state=\(self.state), task=\(self.task != nil))")
                self.pendingSends.append(data)
                return
            }
            // Send as TEXT frame, not binary.  Relay (Node `ws`) parses
            // incoming WS messages as JSON text; binary frames are dropped.
            let text = String(data: data, encoding: .utf8) ?? ""
            let msg = URLSessionWebSocketTask.Message.string(text)
            task.send(msg) { err in
                if let err = err {
                    sigClientLog("WS send err: \(err.localizedDescription)")
                }
            }
        }
    }

    // ===== Internals =====

    private func connect() {
        setState(reconnectAttempts == 0 ? .connecting : .reconnecting)
        var url = relayUrl
        if !url.absoluteString.hasSuffix("/api/relay") {
            url = url.appendingPathComponent("/api/relay")
        }
        NSLog("[codex-link] connect() opening WS to %@", url.absoluteString)
        var req = URLRequest(url: url)
        req.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        let t = session.webSocketTask(with: req)
        task = t
        t.resume()
        readNext(task: t)
        // Open 状態は最初のメッセージか setState で扱う. URLSession の
        // webSocketTask には明示的な `open` callback が無いので、最初の receive
        // が成功した時点で open とする.
    }

    private func readNext(task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self = self else { return }
            self.queue.async {
                switch result {
                case .success(let message):
                    NSLog("[codex-link] WS received message")
                    if self.state != .open {
                        self.reconnectAttempts = 0
                        self.setState(.open)
                        self.flushPending()
                    }
                    self.handleIncoming(message)
                    self.readNext(task: task)
                case .failure(let err):
                    NSLog("[codex-link] WS failure: %@", err.localizedDescription)
                    if self.intentionallyClosed {
                        self.setState(.closed)
                        return
                    }
                    self.scheduleReconnect(reason: err.localizedDescription)
                }
            }
        }
    }

    private func handleIncoming(_ message: URLSessionWebSocketTask.Message) {
        let data: Data
        switch message {
        case .string(let s): data = Data(s.utf8)
        case .data(let d): data = d
        @unknown default: return
        }
        guard let outbound = try? JSONDecoder().decode(WsOutbound.self, from: data) else {
            // 未知 type は無視 (forward compat).
            return
        }
        switch outbound {
        case .welcome(let u, let d):
            delegate?.signalingClient(self, didReceiveWelcome: u, deviceId: d)
        case .signalFromHost(let r):
            delegate?.signalingClient(self, didReceiveHostSignal: r)
        case .turnCredentialIssued(let c, let h):
            delegate?.signalingClient(self, didReceiveTurnCredential: c, hostId: h)
        case .error(let code, let msg, let corr):
            delegate?.signalingClient(self, didReceiveError: code, message: msg, correlationType: corr)
        }
    }

    private func flushPending() {
        guard let t = task else { return }
        let toSend = pendingSends
        pendingSends.removeAll()
        for data in toSend {
            t.send(.data(data)) { _ in }
        }
    }

    private func scheduleReconnect(reason: String) {
        _ = reason
        reconnectAttempts += 1
        let base = reconnectMinMs * Int(pow(2.0, Double(min(reconnectAttempts - 1, 8))))
        let capped = min(base, reconnectMaxMs)
        let jitter = Int.random(in: 0..<min(capped, 500))
        let wait = capped + jitter
        setState(.reconnecting)
        queue.asyncAfter(deadline: .now() + .milliseconds(wait)) { [weak self] in
            guard let self = self, !self.intentionallyClosed else { return }
            self.connect()
        }
    }

    private func setState(_ s: SignalingClientState) {
        guard state != s else { return }
        state = s
        delegate?.signalingClient(self, didChangeState: s)
    }
}

// SignalingClientState の equality (内部使用).
extension SignalingClientState: Equatable {
    public static func == (lhs: SignalingClientState, rhs: SignalingClientState) -> Bool {
        switch (lhs, rhs) {
        case (.idle, .idle), (.connecting, .connecting), (.open, .open),
             (.reconnecting, .reconnecting), (.closed, .closed):
            return true
        default:
            return false
        }
    }
}
