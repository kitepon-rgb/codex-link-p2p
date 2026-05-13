// Signaling envelope forwarding decision.
//
// 設計:
// - 実際の WebSocket 送信は Phase 2.5 の websocket.ts が行う。本ファイルは
//   「forward すべきか / buffer すべきか / 拒否すべきか」の判定だけを担う.
// - Relay は payload (sdpBase64 / candidateBase64) を **絶対に decode しない**。
//   envelope は opaque box として通すだけ.
// - ACL: from* user が toHostId に HostAccess を持つことを確認.
// - identity guard: envelope の fromUserId / fromDeviceId が、認証済みの
//   session と一致することを確認 (なりすまし防止).
// - rate limit: per-user signal forward rate を 1 分窓で制限.
// - Host が online でないなら pendingSignals に enqueue (TTL は呼び出し側
//   が sweep). online なら deliver decision を返す.

import type {
  DeviceId,
  HostId,
  SignalEnvelope,
  UserId,
} from "@codex-link/protocol/rendezvous";

import { RelayError, assertHostAccess } from "./relay.js";
import {
  drainPendingSignals,
  enqueuePendingSignal,
  peekSignalForwardRateLimit,
  recordAudit,
  recordSignalForwardIssuance,
  sweepExpiredPendingSignals,
  type AuditEvent,
  type AuditEventKind,
  type AuditOutcome,
  type PendingSignal,
  type RelayState,
} from "./state.js";

export const SIGNAL_RATE_WINDOW_MS = 60_000;

export type ForwardSignalDecision =
  | { readonly kind: "delivered"; readonly hostId: HostId; readonly envelope: SignalEnvelope }
  | { readonly kind: "buffered"; readonly hostId: HostId; readonly envelope: SignalEnvelope };

export interface ForwardSignalInput {
  readonly state: RelayState;
  readonly envelope: SignalEnvelope;
  readonly authenticatedUserId: UserId;
  readonly authenticatedDeviceId: DeviceId;
  readonly isHostOnline: (hostId: HostId) => boolean;
  readonly ratePerMinute: number;
  readonly now: number;
  readonly maxAuditEvents: number;
}

interface AuditFields {
  readonly kind: AuditEventKind;
  readonly outcome: AuditOutcome;
  readonly userId: UserId | null;
  readonly deviceId: DeviceId | null;
  readonly hostId: HostId | null;
  readonly note?: string;
}

const audit = (
  state: RelayState,
  maxEvents: number,
  at: number,
  fields: AuditFields,
): void => {
  const event: AuditEvent = {
    at,
    kind: fields.kind,
    outcome: fields.outcome,
    userId: fields.userId,
    deviceId: fields.deviceId,
    hostId: fields.hostId,
    ...(fields.note !== undefined ? { note: fields.note } : {}),
  };
  recordAudit({ state, event, maxEvents });
};

export const forwardSignal = ({
  state,
  envelope,
  authenticatedUserId,
  authenticatedDeviceId,
  isHostOnline,
  ratePerMinute,
  now,
  maxAuditEvents,
}: ForwardSignalInput): ForwardSignalDecision => {
  // (1) なりすまし防止: envelope の from* が認証された session と一致するか.
  if (
    envelope.fromUserId !== authenticatedUserId ||
    envelope.fromDeviceId !== authenticatedDeviceId
  ) {
    audit(state, maxAuditEvents, now, {
      kind: "signal.dropped_identity_mismatch",
      outcome: "denied",
      userId: authenticatedUserId,
      deviceId: authenticatedDeviceId,
      hostId: envelope.toHostId,
      note: "envelope from* does not match authenticated session",
    });
    throw new RelayError(
      "signal_invalid",
      "envelope fromUserId / fromDeviceId does not match the authenticated session",
    );
  }

  // (2) ACL: from user が toHost に HostAccess を持つか.
  try {
    assertHostAccess({
      state,
      userId: authenticatedUserId,
      hostId: envelope.toHostId,
    });
  } catch (e) {
    audit(state, maxAuditEvents, now, {
      kind: "signal.dropped_no_access",
      outcome: "denied",
      userId: authenticatedUserId,
      deviceId: authenticatedDeviceId,
      hostId: envelope.toHostId,
    });
    throw e;
  }

  // (3) Rate limit (peek; 上限到達なら record はせず拒否).
  const peek = peekSignalForwardRateLimit({
    state,
    userId: authenticatedUserId,
    now,
    windowMs: SIGNAL_RATE_WINDOW_MS,
  });
  if (peek.recentCount >= ratePerMinute) {
    audit(state, maxAuditEvents, now, {
      kind: "signal.rate_limited",
      outcome: "rate_limited",
      userId: authenticatedUserId,
      deviceId: authenticatedDeviceId,
      hostId: envelope.toHostId,
    });
    throw new RelayError(
      "rate_limited",
      `signal forward rate-limited for user ${
        authenticatedUserId as string
      } (>= ${ratePerMinute}/min)`,
    );
  }

  recordSignalForwardIssuance({
    state,
    userId: authenticatedUserId,
    now,
    windowMs: SIGNAL_RATE_WINDOW_MS,
  });

  // (4) Host online なら deliver、offline なら buffer.
  if (isHostOnline(envelope.toHostId)) {
    audit(state, maxAuditEvents, now, {
      kind: "signal.forwarded",
      outcome: "ok",
      userId: authenticatedUserId,
      deviceId: authenticatedDeviceId,
      hostId: envelope.toHostId,
      note: envelope.signal.kind,
    });
    return { kind: "delivered", hostId: envelope.toHostId, envelope };
  }

  enqueuePendingSignal({
    state,
    hostId: envelope.toHostId,
    envelope,
    now,
  });
  audit(state, maxAuditEvents, now, {
    kind: "signal.buffered",
    outcome: "ok",
    userId: authenticatedUserId,
    deviceId: authenticatedDeviceId,
    hostId: envelope.toHostId,
    note: envelope.signal.kind,
  });
  return { kind: "buffered", hostId: envelope.toHostId, envelope };
};

// ===== Host coming online → drain buffer =====

export interface DrainBufferOnHostOnlineInput {
  readonly state: RelayState;
  readonly hostId: HostId;
  readonly now: number;
  readonly ttlMs: number;
  readonly maxAuditEvents: number;
}

export interface DrainBufferOnHostOnlineResult {
  // Host が今すぐ受け取るべき envelope 群 (TTL 内のもの).
  readonly deliver: readonly SignalEnvelope[];
  // Drop された (TTL 切れ) envelope 群 — audit 済み, 配送はしない.
  readonly dropped: readonly SignalEnvelope[];
}

// Host が WS 接続を確立したタイミングで呼ぶ。
// pendingSignals から該当 host の buffer を取り出し、TTL 切れは drop、
// 残りを deliver 配列として返す.
export const drainBufferOnHostOnline = ({
  state,
  hostId,
  now,
  ttlMs,
  maxAuditEvents,
}: DrainBufferOnHostOnlineInput): DrainBufferOnHostOnlineResult => {
  const drained = drainPendingSignals({ state, hostId });
  if (drained.length === 0) {
    return { deliver: [], dropped: [] };
  }
  const deadline = now - ttlMs;
  const deliver: SignalEnvelope[] = [];
  const dropped: SignalEnvelope[] = [];
  for (const item of drained) {
    if (item.enqueuedAt < deadline) {
      dropped.push(item.envelope);
      audit(state, maxAuditEvents, now, {
        kind: "signal.expired",
        outcome: "expired",
        userId: item.envelope.fromUserId,
        deviceId: item.envelope.fromDeviceId,
        hostId,
      });
    } else {
      deliver.push(item.envelope);
      audit(state, maxAuditEvents, now, {
        kind: "signal.delivered_from_buffer",
        outcome: "ok",
        userId: item.envelope.fromUserId,
        deviceId: item.envelope.fromDeviceId,
        hostId,
        note: item.envelope.signal.kind,
      });
    }
  }
  return { deliver, dropped };
};

// 定期 sweep: いまだ誰も online でない host の buffer から TTL 切れを廃棄.
export interface SweepStaleBuffersInput {
  readonly state: RelayState;
  readonly now: number;
  readonly ttlMs: number;
  readonly maxAuditEvents: number;
}

export const sweepStaleBuffers = ({
  state,
  now,
  ttlMs,
  maxAuditEvents,
}: SweepStaleBuffersInput): { readonly expiredCount: number } => {
  const { expired } = sweepExpiredPendingSignals({ state, now, ttlMs });
  for (const item of expired) {
    audit(state, maxAuditEvents, now, {
      kind: "signal.expired",
      outcome: "expired",
      userId: item.envelope.fromUserId,
      deviceId: item.envelope.fromDeviceId,
      hostId: item.hostId,
    });
  }
  return { expiredCount: expired.length };
};

export type { PendingSignal };
