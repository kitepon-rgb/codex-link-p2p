// WebSocket wire messages (Relay ↔ client / Host).
//
// すべて JSON テキストフレーム。各 message には `type` discriminator.
//
// 注意 (CLAUDE.md してはいけないこと):
// - `client.toHost` / `host.event` / `host.subscription.ready` 等 broker 概念の
//   message type を作らない. ここに並ぶのは **signaling envelope + TURN credential +
//   pairing code 発行 + presence + error** だけ.

import type {
  ClientToHostSignalEnvelope,
  DeviceId,
  HostId,
  HostSignalReply,
  RtcSignal,
  TurnCredential,
  UserId,
} from "@codex-link/protocol/rendezvous";

// ===== Inbound (client / Host → Relay) =====

// client (iPhone) → Relay: Host へ signaling primitive を送る.
export interface InboundSignalToHost {
  readonly type: "signal.to_host";
  readonly hostId: HostId;
  readonly signal: RtcSignal;
  readonly sentAt: number;
}

// Host → Relay: 特定 client (iPhone) へ signaling primitive を返す.
export interface InboundSignalToClient {
  readonly type: "signal.to_client";
  readonly toUserId: UserId;
  readonly toDeviceId: DeviceId;
  // どの Host session に対する reply かを示す context. Host は自身の hostId.
  readonly hostId: HostId;
  readonly signal: RtcSignal;
  readonly sentAt: number;
}

// 両者 → Relay: TURN credential 発行を要求.
export interface InboundTurnCredentialRequest {
  readonly type: "turn.credential.request";
  readonly hostId: HostId;
}

// Host → Relay: 新規 pairing code を発行 (操作者を招くため).
export interface InboundPairingCodeCreate {
  readonly type: "pairing_code.create";
  readonly hostId: HostId;
}

// Host → Relay: この WS が hostId の active session であることを宣言.
export interface InboundHostAnnounce {
  readonly type: "host.announce";
  readonly hostId: HostId;
}

export type WsInbound =
  | InboundSignalToHost
  | InboundSignalToClient
  | InboundTurnCredentialRequest
  | InboundPairingCodeCreate
  | InboundHostAnnounce;

// ===== Outbound (Relay → client / Host) =====

// Relay → Host: client が送ってきた signaling primitive を forward.
export interface OutboundSignalFromClient {
  readonly type: "signal.from_client";
  readonly envelope: ClientToHostSignalEnvelope;
}

// Relay → client: Host が返した signaling primitive を forward.
export interface OutboundSignalFromHost {
  readonly type: "signal.from_host";
  readonly reply: HostSignalReply;
}

// Relay → 両者: TURN credential を発行.
export interface OutboundTurnCredentialIssued {
  readonly type: "turn.credential.issued";
  readonly credential: TurnCredential;
  readonly hostId: HostId;
}

// Relay → Host: pairing code 発行結果 (plaintext code を Host にだけ返す).
export interface OutboundPairingCodeIssued {
  readonly type: "pairing_code.issued";
  readonly code: string;
  readonly expiresAt: number;
  readonly hostId: HostId;
}

// Relay → client/Host: 直前の inbound に対する error.
export interface OutboundError {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
  // どの inbound に対する応答かを相関させたい場合 (echo). MVP は undefined OK.
  readonly correlationType?: string;
}

// Relay → 両者: WS open 直後の welcome (自分の identity を確認).
export interface OutboundWelcome {
  readonly type: "welcome";
  readonly userId: UserId;
  readonly deviceId: DeviceId;
}

export type WsOutbound =
  | OutboundSignalFromClient
  | OutboundSignalFromHost
  | OutboundTurnCredentialIssued
  | OutboundPairingCodeIssued
  | OutboundError
  | OutboundWelcome;
