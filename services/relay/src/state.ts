// Relay の in-memory state container.
//
// 注意:
// - **event cache を持たない**。Codex event は DataChannel 上のみで流れる
//   ため Relay に存在しない (CLAUDE.md 鉄則).
// - Audit log は signaling のメタ情報のみ。signal の SDP / candidate 本体や
//   CodexLinkEvent payload は記録しない.
// - pendingSignals は Host offline 中の signaling envelope を短時間 buffer
//   する用途のみ。TTL を過ぎたものは sweepExpiredPendingSignals で破棄.

import type {
  Device,
  DeviceId,
  Host,
  HostAccess,
  HostId,
  HostPairingCode,
  SignalEnvelope,
  User,
  UserId,
} from "@codex-link/protocol/rendezvous";

// ===== Relay-internal records =====
//
// protocol の Device / Host は client / Host 両方が見える wire 型。
// session token hash のような **Relay 内部のみが保つ** フィールドはここで
// 拡張する (protocol 型に混ぜない).

export interface DeviceRecord extends Device {
  // Relay は token 本体を保存しない。SHA-256 hex hash のみ保管し、認証時に
  // 受け取った token を hash して比較する。
  readonly sessionTokenHash: string;
  readonly revokedAt?: number;
}

// ===== Audit =====
//
// kind は signaling / pairing / TURN credential 発行に関するメタ情報のみ。
// **broker 経路 (host.event 等) は存在しない**ので、それに関する kind は無い。

export type AuditEventKind =
  | "user.created"
  | "device.created"
  | "device.session.revoked"
  | "host.bootstrap"
  | "host.access.granted"
  | "host.access.revoked"
  | "pairing.created"
  | "pairing.redeemed"
  | "pairing.expired"
  | "signal.forwarded"
  | "signal.buffered"
  | "signal.delivered_from_buffer"
  | "signal.expired"
  | "signal.dropped_no_access"
  | "turn.credential.issued"
  | "turn.credential.rate_limited";

export type AuditOutcome = "ok" | "denied" | "rate_limited" | "expired";

export interface AuditEvent {
  readonly at: number;
  readonly kind: AuditEventKind;
  readonly outcome: AuditOutcome;
  readonly userId: UserId | null;
  readonly deviceId: DeviceId | null;
  readonly hostId: HostId | null;
  // Free-form short note (≤ 200 chars). signaling SDP / payload 本体は
  // 絶対に入れない。route メタや エラー code のみ。
  readonly note?: string;
}

// ===== Pending signal buffer =====
//
// Host が一時的に offline の時、iPhone 由来の signal を短時間だけ buffer
// する。TTL を過ぎたものは破棄する (signaling の半端な再送によって stale
// な ICE candidate が peer に流れ込むのを防ぐ).

export interface PendingSignal {
  readonly envelope: SignalEnvelope;
  readonly enqueuedAt: number;
}

// ===== TURN credential rate-limit ring =====
//
// per-user に「直近 1 分間に発行した credential の timestamp 列」を保持し、
// 1 分窓を超えたものを sweep する。Phase 2.3 で issueTurnCredential が
// 読み書きする。

export interface TurnIssuanceWindow {
  readonly userId: UserId;
  readonly recent: number[]; // timestamps in ms; sorted ascending
}

// ===== HostAccess key =====
//
// HostAccess を (hostId, userId) の組で引きたいので、Map のキー形式を
// 中央集権で固定する。

export const hostAccessKey = (hostId: HostId, userId: UserId): string =>
  `${hostId as string}:${userId as string}`;

// ===== Relay state =====

export interface RelayState {
  users: Map<UserId, User>;
  devices: Map<DeviceId, DeviceRecord>;
  // Secondary index: SHA-256 hex hash of session token → deviceId.
  // 認証 header を受けた時に O(1) で device 引きする。
  deviceTokenHashIndex: Map<string, DeviceId>;
  hosts: Map<HostId, Host>;
  hostAccess: Map<string, HostAccess>; // key = hostAccessKey(hostId, userId)
  pairingCodes: Map<HostId, HostPairingCode>; // 1 active code per host
  pendingSignals: Map<HostId, PendingSignal[]>;
  turnCredentialIssuance: Map<UserId, TurnIssuanceWindow>;
  auditEvents: AuditEvent[]; // bounded by config.auditMaxEvents
}

export const createRelayState = (): RelayState => ({
  users: new Map(),
  devices: new Map(),
  deviceTokenHashIndex: new Map(),
  hosts: new Map(),
  hostAccess: new Map(),
  pairingCodes: new Map(),
  pendingSignals: new Map(),
  turnCredentialIssuance: new Map(),
  auditEvents: [],
});

// ===== Mutators (low-level) =====
//
// 本格的な business logic (createUser など) は relay.ts (Phase 2.2). ここは
// 「データ at rest」の操作のみ.

export interface RecordAuditInput {
  readonly state: RelayState;
  readonly event: AuditEvent;
  readonly maxEvents: number;
}

export const recordAudit = ({
  state,
  event,
  maxEvents,
}: RecordAuditInput): void => {
  state.auditEvents.push(event);
  // FIFO bounded retention. 越えた分を頭から落とす.
  if (state.auditEvents.length > maxEvents) {
    state.auditEvents.splice(0, state.auditEvents.length - maxEvents);
  }
};

export interface EnqueuePendingSignalInput {
  readonly state: RelayState;
  readonly hostId: HostId;
  readonly envelope: SignalEnvelope;
  readonly now: number;
}

export const enqueuePendingSignal = ({
  state,
  hostId,
  envelope,
  now,
}: EnqueuePendingSignalInput): void => {
  const list = state.pendingSignals.get(hostId);
  const entry: PendingSignal = { envelope, enqueuedAt: now };
  if (list === undefined) {
    state.pendingSignals.set(hostId, [entry]);
  } else {
    list.push(entry);
  }
};

export interface DrainPendingSignalsInput {
  readonly state: RelayState;
  readonly hostId: HostId;
}

// Host が online に戻った瞬間に呼ぶ。bucket を空にして配列を返す.
export const drainPendingSignals = ({
  state,
  hostId,
}: DrainPendingSignalsInput): PendingSignal[] => {
  const list = state.pendingSignals.get(hostId);
  if (list === undefined || list.length === 0) return [];
  state.pendingSignals.delete(hostId);
  return list;
};

export interface SweepExpiredPendingSignalsInput {
  readonly state: RelayState;
  readonly now: number;
  readonly ttlMs: number;
}

export interface SweepExpiredPendingSignalsResult {
  readonly expired: ReadonlyArray<{
    readonly hostId: HostId;
    readonly envelope: SignalEnvelope;
  }>;
}

export const sweepExpiredPendingSignals = ({
  state,
  now,
  ttlMs,
}: SweepExpiredPendingSignalsInput): SweepExpiredPendingSignalsResult => {
  const expired: Array<{ hostId: HostId; envelope: SignalEnvelope }> = [];
  const deadline = now - ttlMs;
  for (const [hostId, list] of state.pendingSignals) {
    const keep: PendingSignal[] = [];
    for (const item of list) {
      if (item.enqueuedAt < deadline) {
        expired.push({ hostId, envelope: item.envelope });
      } else {
        keep.push(item);
      }
    }
    if (keep.length === 0) {
      state.pendingSignals.delete(hostId);
    } else if (keep.length !== list.length) {
      state.pendingSignals.set(hostId, keep);
    }
  }
  return { expired };
};

// ===== TURN credential rate-limit =====

export interface TurnRateLimitSnapshot {
  readonly userId: UserId;
  readonly recentCount: number;
}

export interface RecordTurnIssuanceInput {
  readonly state: RelayState;
  readonly userId: UserId;
  readonly now: number;
  readonly windowMs: number;
}

// 1 分窓に古い entry を sweep してから timestamp を 1 つ追加し、
// 現在の窓内の発行数を返す.
export const recordTurnIssuance = ({
  state,
  userId,
  now,
  windowMs,
}: RecordTurnIssuanceInput): TurnRateLimitSnapshot => {
  const existing = state.turnCredentialIssuance.get(userId);
  const cutoff = now - windowMs;
  const kept = (existing?.recent ?? []).filter((t) => t >= cutoff);
  kept.push(now);
  state.turnCredentialIssuance.set(userId, { userId, recent: kept });
  return { userId, recentCount: kept.length };
};

export interface PeekTurnRateLimitInput {
  readonly state: RelayState;
  readonly userId: UserId;
  readonly now: number;
  readonly windowMs: number;
}

// 副作用無しで現在の窓内発行数を覗き見る (sweep だけは行う).
export const peekTurnRateLimit = ({
  state,
  userId,
  now,
  windowMs,
}: PeekTurnRateLimitInput): TurnRateLimitSnapshot => {
  const existing = state.turnCredentialIssuance.get(userId);
  if (existing === undefined) return { userId, recentCount: 0 };
  const cutoff = now - windowMs;
  const kept = existing.recent.filter((t) => t >= cutoff);
  if (kept.length === 0) {
    state.turnCredentialIssuance.delete(userId);
    return { userId, recentCount: 0 };
  }
  state.turnCredentialIssuance.set(userId, { userId, recent: kept });
  return { userId, recentCount: kept.length };
};
