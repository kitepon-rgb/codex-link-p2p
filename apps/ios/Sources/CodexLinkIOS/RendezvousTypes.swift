// Rendezvous protocol types (Relay-visible).
//
// TypeScript `packages/protocol/src/rendezvous.ts` の対応物。
// JSON encoding は CodingKeys / @discriminator 経由で Relay の wire 形式と一致.

import Foundation

// ===== WebRTC signaling =====

public enum RtcConnectionState: String, Codable, Sendable {
    case new, checking, connected, completed, failed, disconnected, closed
}

// Discriminated union: RtcSignal = { kind: "offer" | "answer" | "ice" | "connectionState", ... }
public enum RtcSignal: Codable, Sendable, Equatable {
    case offer(sdpBase64: String)
    case answer(sdpBase64: String)
    case ice(candidateBase64: String, sdpMid: String?, sdpMLineIndex: Int?)
    case connectionState(state: RtcConnectionState)

    private enum CodingKeys: String, CodingKey {
        case kind, sdpBase64, candidateBase64, sdpMid, sdpMLineIndex, state
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "offer":
            self = .offer(sdpBase64: try c.decode(String.self, forKey: .sdpBase64))
        case "answer":
            self = .answer(sdpBase64: try c.decode(String.self, forKey: .sdpBase64))
        case "ice":
            self = .ice(
                candidateBase64: try c.decode(String.self, forKey: .candidateBase64),
                sdpMid: try c.decodeIfPresent(String.self, forKey: .sdpMid),
                sdpMLineIndex: try c.decodeIfPresent(Int.self, forKey: .sdpMLineIndex)
            )
        case "connectionState":
            self = .connectionState(state: try c.decode(RtcConnectionState.self, forKey: .state))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind, in: c,
                debugDescription: "unknown RtcSignal kind: \(kind)"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .offer(let sdp):
            try c.encode("offer", forKey: .kind)
            try c.encode(sdp, forKey: .sdpBase64)
        case .answer(let sdp):
            try c.encode("answer", forKey: .kind)
            try c.encode(sdp, forKey: .sdpBase64)
        case .ice(let cand, let mid, let line):
            try c.encode("ice", forKey: .kind)
            try c.encode(cand, forKey: .candidateBase64)
            try c.encode(mid, forKey: .sdpMid)
            try c.encode(line, forKey: .sdpMLineIndex)
        case .connectionState(let s):
            try c.encode("connectionState", forKey: .kind)
            try c.encode(s, forKey: .state)
        }
    }
}

// ===== Envelopes =====

public struct ClientToHostSignalEnvelope: Codable, Sendable, Equatable {
    public let fromUserId: UserId
    public let fromDeviceId: DeviceId
    public let toHostId: HostId
    public let signal: RtcSignal
    public let sentAt: Int

    public init(
        fromUserId: UserId,
        fromDeviceId: DeviceId,
        toHostId: HostId,
        signal: RtcSignal,
        sentAt: Int
    ) {
        self.fromUserId = fromUserId
        self.fromDeviceId = fromDeviceId
        self.toHostId = toHostId
        self.signal = signal
        self.sentAt = sentAt
    }
}

public struct HostSignalReply: Codable, Sendable, Equatable {
    public let fromHostId: HostId
    public let toUserId: UserId
    public let toDeviceId: DeviceId
    public let signal: RtcSignal
    public let sentAt: Int

    public init(
        fromHostId: HostId,
        toUserId: UserId,
        toDeviceId: DeviceId,
        signal: RtcSignal,
        sentAt: Int
    ) {
        self.fromHostId = fromHostId
        self.toUserId = toUserId
        self.toDeviceId = toDeviceId
        self.signal = signal
        self.sentAt = sentAt
    }
}

// ===== TURN credential =====

public struct TurnCredential: Codable, Sendable, Equatable {
    public let username: String
    public let password: String
    public let ttlSec: Int
    public let expiresAt: Int
    public let urls: [String]

    public init(username: String, password: String, ttlSec: Int, expiresAt: Int, urls: [String]) {
        self.username = username
        self.password = password
        self.ttlSec = ttlSec
        self.expiresAt = expiresAt
        self.urls = urls
    }
}

// ===== HostAccess role =====

public enum HostAccessRole: String, Codable, Sendable {
    case owner, operator_ = "operator", viewer

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        switch raw {
        case "owner": self = .owner
        case "operator": self = .operator_
        case "viewer": self = .viewer
        default:
            throw DecodingError.dataCorruptedError(
                in: try decoder.singleValueContainer(),
                debugDescription: "unknown HostAccessRole: \(raw)"
            )
        }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .owner: try c.encode("owner")
        case .operator_: try c.encode("operator")
        case .viewer: try c.encode("viewer")
        }
    }
}

// ===== WS wire types (inbound / outbound) =====
//
// iOS は **client 側** として動くので、Mac Host 向け WS と同じ wire を話す
// (signal.to_host / turn.credential.request 等を送り、signal.from_host /
// turn.credential.issued / welcome / error を受ける).

public enum WsInbound: Codable, Sendable {
    case signalToHost(hostId: HostId, signal: RtcSignal, sentAt: Int)
    case turnCredentialRequest(hostId: HostId)

    private enum CodingKeys: String, CodingKey {
        case type, hostId, signal, sentAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "signal.to_host":
            self = .signalToHost(
                hostId: try c.decode(HostId.self, forKey: .hostId),
                signal: try c.decode(RtcSignal.self, forKey: .signal),
                sentAt: try c.decode(Int.self, forKey: .sentAt)
            )
        case "turn.credential.request":
            self = .turnCredentialRequest(
                hostId: try c.decode(HostId.self, forKey: .hostId)
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: c,
                debugDescription: "unsupported inbound type for iOS client: \(type)"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .signalToHost(let hostId, let signal, let sentAt):
            try c.encode("signal.to_host", forKey: .type)
            try c.encode(hostId, forKey: .hostId)
            try c.encode(signal, forKey: .signal)
            try c.encode(sentAt, forKey: .sentAt)
        case .turnCredentialRequest(let hostId):
            try c.encode("turn.credential.request", forKey: .type)
            try c.encode(hostId, forKey: .hostId)
        }
    }
}

public enum WsOutbound: Codable, Sendable, Equatable {
    case welcome(userId: UserId, deviceId: DeviceId)
    case signalFromHost(reply: HostSignalReply)
    case turnCredentialIssued(credential: TurnCredential, hostId: HostId)
    case error(code: String, message: String, correlationType: String?)

    private enum CodingKeys: String, CodingKey {
        case type, userId, deviceId, reply, credential, hostId
        case code, message, correlationType
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "welcome":
            self = .welcome(
                userId: try c.decode(UserId.self, forKey: .userId),
                deviceId: try c.decode(DeviceId.self, forKey: .deviceId)
            )
        case "signal.from_host":
            self = .signalFromHost(
                reply: try c.decode(HostSignalReply.self, forKey: .reply)
            )
        case "turn.credential.issued":
            self = .turnCredentialIssued(
                credential: try c.decode(TurnCredential.self, forKey: .credential),
                hostId: try c.decode(HostId.self, forKey: .hostId)
            )
        case "error":
            self = .error(
                code: try c.decode(String.self, forKey: .code),
                message: try c.decode(String.self, forKey: .message),
                correlationType: try c.decodeIfPresent(String.self, forKey: .correlationType)
            )
        default:
            // iOS は signal.from_client / pairing_code.issued を受けないが、
            // 共通 protocol module としては受領可能性を残す. ここでは error 扱い.
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: c,
                debugDescription: "unsupported outbound type for iOS client: \(type)"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .welcome(let u, let d):
            try c.encode("welcome", forKey: .type)
            try c.encode(u, forKey: .userId)
            try c.encode(d, forKey: .deviceId)
        case .signalFromHost(let r):
            try c.encode("signal.from_host", forKey: .type)
            try c.encode(r, forKey: .reply)
        case .turnCredentialIssued(let cr, let h):
            try c.encode("turn.credential.issued", forKey: .type)
            try c.encode(cr, forKey: .credential)
            try c.encode(h, forKey: .hostId)
        case .error(let code, let message, let corr):
            try c.encode("error", forKey: .type)
            try c.encode(code, forKey: .code)
            try c.encode(message, forKey: .message)
            try c.encodeIfPresent(corr, forKey: .correlationType)
        }
    }
}
