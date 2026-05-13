import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { asHostId, asUserId } from "@codex-link/protocol/rendezvous";

import { bootstrapHost, RelayError } from "../src/relay.js";
import {
  createRelayState,
  type RelayState,
} from "../src/state.js";
import {
  TURN_RATE_WINDOW_MS,
  issueTurnCredential,
  verifyTurnPassword,
} from "../src/turn.js";

const MAX_AUDIT = 1_000;
const SECRET = "test-turn-shared-secret";
const URLS = [
  "stun:stun.l.google.com:19302",
  "turn:turn.example:3478",
] as const;
const BOOTSTRAP_TOKEN = "test-bootstrap";

let state: RelayState;
let now = 1_700_000_000_000; // ms

const setupOwner = () =>
  bootstrapHost({
    state,
    providedBootstrapToken: BOOTSTRAP_TOKEN,
    configuredBootstrapToken: BOOTSTRAP_TOKEN,
    userDisplayName: "x",
    hostDisplayName: "x",
    hostPlatform: "macos",
    devicePlatform: "macos",
    now,
    maxAuditEvents: MAX_AUDIT,
  });

beforeEach(() => {
  state = createRelayState();
  now = 1_700_000_000_000;
});

describe("issueTurnCredential", () => {
  it("returns a credential with username/password matching coturn use-auth-secret", () => {
    const { user, host } = setupOwner();
    const ttl = 300;

    const cred = issueTurnCredential({
      state,
      userId: user.id,
      hostId: host.id,
      now,
      turnSharedSecret: SECRET,
      turnUrls: URLS,
      ttlSec: ttl,
      ratePerMinute: 30,
      maxAuditEvents: MAX_AUDIT,
    });

    const expectedExpirySec = Math.floor(now / 1_000) + ttl;
    expect(cred.username).toBe(`${expectedExpirySec}:${user.id as string}`);
    expect(cred.expiresAt).toBe(expectedExpirySec * 1_000);
    expect(cred.ttlSec).toBe(ttl);
    expect(cred.urls).toEqual(URLS);

    // password = base64(HMAC-SHA1(secret, username))
    const expectedPassword = createHmac("sha1", SECRET)
      .update(cred.username, "utf8")
      .digest("base64");
    expect(cred.password).toBe(expectedPassword);
  });

  it("verifyTurnPassword accepts a freshly issued credential", () => {
    const { user, host } = setupOwner();
    const cred = issueTurnCredential({
      state,
      userId: user.id,
      hostId: host.id,
      now,
      turnSharedSecret: SECRET,
      turnUrls: URLS,
      ttlSec: 300,
      ratePerMinute: 30,
      maxAuditEvents: MAX_AUDIT,
    });
    expect(
      verifyTurnPassword({
        turnSharedSecret: SECRET,
        username: cred.username,
        password: cred.password,
      }),
    ).toBe(true);
  });

  it("verifyTurnPassword rejects a tampered password", () => {
    const { user, host } = setupOwner();
    const cred = issueTurnCredential({
      state,
      userId: user.id,
      hostId: host.id,
      now,
      turnSharedSecret: SECRET,
      turnUrls: URLS,
      ttlSec: 300,
      ratePerMinute: 30,
      maxAuditEvents: MAX_AUDIT,
    });
    const tampered = cred.password.replace(/[A-Za-z]/, (c) =>
      c === "A" ? "B" : "A",
    );
    expect(
      verifyTurnPassword({
        turnSharedSecret: SECRET,
        username: cred.username,
        password: tampered,
      }),
    ).toBe(false);
  });

  it("denies a user without HostAccess (host_access_denied)", () => {
    const { host } = setupOwner();
    expect(() =>
      issueTurnCredential({
        state,
        userId: asUserId("usr_other"),
        hostId: host.id,
        now,
        turnSharedSecret: SECRET,
        turnUrls: URLS,
        ttlSec: 300,
        ratePerMinute: 30,
        maxAuditEvents: MAX_AUDIT,
      }),
    ).toThrow(expect.objectContaining({ code: "host_access_denied" }));
  });

  it("rate-limits a user after ratePerMinute issuances in a 60s window", () => {
    const { user, host } = setupOwner();
    const rate = 3;
    for (let i = 0; i < rate; i++) {
      issueTurnCredential({
        state,
        userId: user.id,
        hostId: host.id,
        now,
        turnSharedSecret: SECRET,
        turnUrls: URLS,
        ttlSec: 300,
        ratePerMinute: rate,
        maxAuditEvents: MAX_AUDIT,
      });
    }
    expect(() =>
      issueTurnCredential({
        state,
        userId: user.id,
        hostId: host.id,
        now,
        turnSharedSecret: SECRET,
        turnUrls: URLS,
        ttlSec: 300,
        ratePerMinute: rate,
        maxAuditEvents: MAX_AUDIT,
      }),
    ).toThrow(expect.objectContaining({ code: "rate_limited" }));

    // audit に rate_limited が記録される.
    const last = state.auditEvents.at(-1);
    expect(last?.kind).toBe("turn.credential.rate_limited");
    expect(last?.outcome).toBe("rate_limited");
  });

  it("allows issuance again after the 60s window elapses", () => {
    const { user, host } = setupOwner();
    const rate = 2;
    for (let i = 0; i < rate; i++) {
      issueTurnCredential({
        state,
        userId: user.id,
        hostId: host.id,
        now,
        turnSharedSecret: SECRET,
        turnUrls: URLS,
        ttlSec: 300,
        ratePerMinute: rate,
        maxAuditEvents: MAX_AUDIT,
      });
    }
    expect(() =>
      issueTurnCredential({
        state,
        userId: user.id,
        hostId: host.id,
        now,
        turnSharedSecret: SECRET,
        turnUrls: URLS,
        ttlSec: 300,
        ratePerMinute: rate,
        maxAuditEvents: MAX_AUDIT,
      }),
    ).toThrow();

    // 1 分 + 1ms 経過 → 古い entry は窓外
    expect(() =>
      issueTurnCredential({
        state,
        userId: user.id,
        hostId: host.id,
        now: now + TURN_RATE_WINDOW_MS + 1,
        turnSharedSecret: SECRET,
        turnUrls: URLS,
        ttlSec: 300,
        ratePerMinute: rate,
        maxAuditEvents: MAX_AUDIT,
      }),
    ).not.toThrow();
  });

  it("audits each successful issuance with turn.credential.issued", () => {
    const { user, host } = setupOwner();
    issueTurnCredential({
      state,
      userId: user.id,
      hostId: host.id,
      now,
      turnSharedSecret: SECRET,
      turnUrls: URLS,
      ttlSec: 300,
      ratePerMinute: 30,
      maxAuditEvents: MAX_AUDIT,
    });
    const issued = state.auditEvents.find(
      (e) => e.kind === "turn.credential.issued",
    );
    expect(issued).toBeDefined();
    expect(issued?.outcome).toBe("ok");
    expect(issued?.userId).toBe(user.id);
    expect(issued?.hostId).toBe(host.id);
    // 重要: SDP / payload を含む note は無い (もしくは安全な文字列のみ).
    expect(issued?.note).toBeUndefined();
  });

  it("expiresAt is consistent with ttlSec across multiple issuances", () => {
    const { user, host } = setupOwner();
    const c1 = issueTurnCredential({
      state,
      userId: user.id,
      hostId: host.id,
      now,
      turnSharedSecret: SECRET,
      turnUrls: URLS,
      ttlSec: 300,
      ratePerMinute: 30,
      maxAuditEvents: MAX_AUDIT,
    });
    const c2 = issueTurnCredential({
      state,
      userId: user.id,
      hostId: host.id,
      now: now + 5_000,
      turnSharedSecret: SECRET,
      turnUrls: URLS,
      ttlSec: 300,
      ratePerMinute: 30,
      maxAuditEvents: MAX_AUDIT,
    });
    expect(c2.expiresAt - c1.expiresAt).toBeGreaterThanOrEqual(5_000);
    expect(c2.expiresAt - c1.expiresAt).toBeLessThanOrEqual(6_000);
  });
});
