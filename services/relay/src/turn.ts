// Ephemeral TURN credential 発行.
//
// coturn の `use-auth-secret` モード互換:
//   username = "{unixExpirySec}:{userId}"
//   password = base64(HMAC-SHA1(turnSharedSecret, username))
//
// TTL は config.turnCredentialTtlSec (既定 300s).
// 発行 rate は per-user で 1 分間あたり ratePerMinute に制限する.
// HostAccess を持たない user には発行しない (assertHostAccess 経由).

import { createHmac } from "node:crypto";

import type {
  HostId,
  TurnCredential,
  UserId,
} from "@codex-link/protocol/rendezvous";

import { RelayError, assertHostAccess } from "./relay.js";
import {
  peekTurnRateLimit,
  recordAudit,
  recordTurnIssuance,
  type AuditEvent,
  type RelayState,
} from "./state.js";

export const TURN_RATE_WINDOW_MS = 60_000;

export interface IssueTurnCredentialInput {
  readonly state: RelayState;
  readonly userId: UserId;
  readonly hostId: HostId;
  readonly now: number;
  readonly turnSharedSecret: string;
  readonly turnUrls: readonly string[];
  readonly ttlSec: number;
  readonly ratePerMinute: number;
  readonly maxAuditEvents: number;
}

const audit = (
  state: RelayState,
  maxEvents: number,
  event: AuditEvent,
): void => {
  recordAudit({ state, event, maxEvents });
};

export const issueTurnCredential = ({
  state,
  userId,
  hostId,
  now,
  turnSharedSecret,
  turnUrls,
  ttlSec,
  ratePerMinute,
  maxAuditEvents,
}: IssueTurnCredentialInput): TurnCredential => {
  // ACL: HostAccess を持たないなら発行しない.
  assertHostAccess({ state, userId, hostId });

  // Rate limit: 直近 1 分窓内の発行数を覗いて、上限到達なら拒否.
  const peek = peekTurnRateLimit({
    state,
    userId,
    now,
    windowMs: TURN_RATE_WINDOW_MS,
  });
  if (peek.recentCount >= ratePerMinute) {
    audit(state, maxAuditEvents, {
      at: now,
      kind: "turn.credential.rate_limited",
      outcome: "rate_limited",
      userId,
      deviceId: null,
      hostId,
    });
    throw new RelayError(
      "rate_limited",
      `TURN credential issuance rate-limited for user ${
        userId as string
      } (>= ${ratePerMinute}/min)`,
    );
  }

  // 発行: username = "{unixExpiry}:{userId}", password = base64(HMAC-SHA1).
  const expiryUnixSec = Math.floor(now / 1_000) + ttlSec;
  const username = `${expiryUnixSec}:${userId as string}`;
  const password = createHmac("sha1", turnSharedSecret)
    .update(username, "utf8")
    .digest("base64");

  recordTurnIssuance({
    state,
    userId,
    now,
    windowMs: TURN_RATE_WINDOW_MS,
  });

  audit(state, maxAuditEvents, {
    at: now,
    kind: "turn.credential.issued",
    outcome: "ok",
    userId,
    deviceId: null,
    hostId,
  });

  return {
    username,
    password,
    ttlSec,
    expiresAt: expiryUnixSec * 1_000,
    urls: turnUrls,
  };
};

// 検証用 helper (coturn が同様の計算で credential を検証する。テストや
// integration で対称性確認に使う).
export const verifyTurnPassword = ({
  turnSharedSecret,
  username,
  password,
}: {
  readonly turnSharedSecret: string;
  readonly username: string;
  readonly password: string;
}): boolean => {
  const expected = createHmac("sha1", turnSharedSecret)
    .update(username, "utf8")
    .digest("base64");
  if (expected.length !== password.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ password.charCodeAt(i);
  }
  return diff === 0;
};
