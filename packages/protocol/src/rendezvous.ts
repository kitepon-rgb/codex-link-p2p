// Rendezvous protocol — Relay が見て良い型のみ。
//
// このファイルに置くもの:
// - branded ID: UserId / DeviceId / HostId
// - 認証 / registry: User / Device / Host / HostAccess
// - Pairing: HostPairingCode
// - WebRTC signaling envelope: RtcSignal* / SignalEnvelope
// - TURN credential: TurnCredential (ephemeral, expiresAt 付き)
// - Host presence: HostPresence (signaling-level)
//
// 絶対に置かないもの (= ./session.ts):
// - CodexLinkEvent
// - ApprovalRequest / ApprovalDecision
// - command / UI action payload
// - session snapshot

// ===== Branded IDs =====
//
// 生 string を ID に代入できないようにする。helper 経由でのみ発行できる。

export type UserId = string & { readonly __brand: "UserId" };
export type DeviceId = string & { readonly __brand: "DeviceId" };
export type HostId = string & { readonly __brand: "HostId" };

export const asUserId = (value: string): UserId => value as UserId;
export const asDeviceId = (value: string): DeviceId => value as DeviceId;
export const asHostId = (value: string): HostId => value as HostId;

// ===== Auth / Registry =====

export type DevicePlatform = "ios" | "macos" | "windows" | "linux";

export interface User {
  readonly id: UserId;
  readonly createdAt: number;
}

export interface Device {
  readonly id: DeviceId;
  readonly userId: UserId;
  readonly displayName: string;
  readonly platform: DevicePlatform;
  readonly createdAt: number;
  readonly lastSeenAt: number;
}

export type HostAccessRole = "owner" | "operator" | "viewer";

export type HostPlatform = "macos" | "windows" | "linux";

export interface Host {
  readonly id: HostId;
  readonly ownerUserId: UserId;
  readonly displayName: string;
  readonly platform: HostPlatform;
  readonly createdAt: number;
}

export interface HostAccess {
  readonly hostId: HostId;
  readonly userId: UserId;
  readonly role: HostAccessRole;
  readonly grantedAt: number;
}

// ===== Pairing code =====
//
// Relay は code 本体を保存しない。SHA-256 hash のみ保存し、redeem 時に
// hash 一致を確認する。

export interface HostPairingCode {
  readonly hostId: HostId;
  readonly codeHash: string;
  readonly expiresAt: number;
  readonly createdByDeviceId: DeviceId;
  readonly redeemed: boolean;
}

// ===== TURN credential =====
//
// coturn `use-auth-secret` 互換。Relay が HMAC-SHA1 で per-user に発行する。
// username = "{unixExpiry}:{userId}"、password = base64(HMAC-SHA1(secret, username)).

export interface TurnCredential {
  readonly username: string;
  readonly password: string;
  readonly ttlSec: number;
  readonly expiresAt: number;
  readonly urls: readonly string[];
}

// ===== WebRTC signaling =====
//
// SDP / ICE candidate は Relay にとって opaque。base64 でエンコードした
// まま forward する。Relay は中身を decode しない (型上も string のまま)。

export type RtcConnectionState =
  | "new"
  | "checking"
  | "connected"
  | "completed"
  | "failed"
  | "disconnected"
  | "closed";

export interface RtcSignalOffer {
  readonly kind: "offer";
  readonly sdpBase64: string;
}

export interface RtcSignalAnswer {
  readonly kind: "answer";
  readonly sdpBase64: string;
}

export interface RtcIceCandidate {
  readonly kind: "ice";
  readonly candidateBase64: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
}

export interface RtcConnectionStateReport {
  readonly kind: "connectionState";
  readonly state: RtcConnectionState;
}

export type RtcSignal =
  | RtcSignalOffer
  | RtcSignalAnswer
  | RtcIceCandidate
  | RtcConnectionStateReport;

// SignalEnvelope: Relay-visible 包み。Relay は中身の signal の payload を
// 読まない。`from*` / `to*` の routing メタ情報と sentAt だけが Relay の
// 見える範囲。
export interface SignalEnvelope {
  readonly fromUserId: UserId;
  readonly fromDeviceId: DeviceId;
  readonly toHostId: HostId;
  readonly signal: RtcSignal;
  readonly sentAt: number;
}

// ===== Host presence (signaling-level, NOT a DataChannel event) =====
//
// host.online / host.offline は Relay 上で扱う registry 更新通知。
// DataChannel 上の CodexLinkEvent ではないことに注意。

export interface HostPresenceOnline {
  readonly kind: "host.online";
  readonly hostId: HostId;
  readonly at: number;
}

export interface HostPresenceOffline {
  readonly kind: "host.offline";
  readonly hostId: HostId;
  readonly at: number;
}

export type HostPresence = HostPresenceOnline | HostPresenceOffline;
