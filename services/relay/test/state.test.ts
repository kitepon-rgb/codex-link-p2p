import { describe, expect, it } from "vitest";

import {
  asDeviceId,
  asHostId,
  asUserId,
  type SignalEnvelope,
} from "@codex-link/protocol/rendezvous";

import {
  createRelayState,
  drainPendingSignals,
  enqueuePendingSignal,
  hostAccessKey,
  peekTurnRateLimit,
  recordAudit,
  recordTurnIssuance,
  sweepExpiredPendingSignals,
  type AuditEvent,
} from "../src/state.js";

const userId = asUserId("user-1");
const deviceId = asDeviceId("device-1");
const hostId = asHostId("host-1");
const otherHost = asHostId("host-2");

const sampleEnvelope: SignalEnvelope = {
  fromUserId: userId,
  fromDeviceId: deviceId,
  toHostId: hostId,
  signal: { kind: "offer", sdpBase64: "djA9MA==" },
  sentAt: 1_700_000_000_000,
};

describe("createRelayState", () => {
  it("starts empty", () => {
    const s = createRelayState();
    expect(s.users.size).toBe(0);
    expect(s.devices.size).toBe(0);
    expect(s.hosts.size).toBe(0);
    expect(s.hostAccess.size).toBe(0);
    expect(s.pairingCodes.size).toBe(0);
    expect(s.pendingSignals.size).toBe(0);
    expect(s.turnCredentialIssuance.size).toBe(0);
    expect(s.auditEvents).toEqual([]);
  });
});

describe("hostAccessKey", () => {
  it("composes hostId and userId deterministically", () => {
    expect(hostAccessKey(hostId, userId)).toBe("host-1:user-1");
  });
});

describe("recordAudit", () => {
  const make = (kind: AuditEvent["kind"], at: number): AuditEvent => ({
    at,
    kind,
    outcome: "ok",
    userId,
    deviceId,
    hostId,
  });

  it("appends events in order", () => {
    const s = createRelayState();
    recordAudit({
      state: s,
      event: make("signal.forwarded", 1),
      maxEvents: 10,
    });
    recordAudit({
      state: s,
      event: make("turn.credential.issued", 2),
      maxEvents: 10,
    });
    expect(s.auditEvents.map((e) => e.kind)).toEqual([
      "signal.forwarded",
      "turn.credential.issued",
    ]);
  });

  it("drops oldest entries beyond maxEvents (FIFO)", () => {
    const s = createRelayState();
    for (let i = 0; i < 5; i++) {
      recordAudit({
        state: s,
        event: make("signal.forwarded", i),
        maxEvents: 3,
      });
    }
    expect(s.auditEvents.length).toBe(3);
    expect(s.auditEvents.map((e) => e.at)).toEqual([2, 3, 4]);
  });
});

describe("pendingSignals", () => {
  it("enqueue groups envelopes by hostId", () => {
    const s = createRelayState();
    enqueuePendingSignal({
      state: s,
      hostId,
      envelope: sampleEnvelope,
      now: 0,
    });
    enqueuePendingSignal({
      state: s,
      hostId,
      envelope: sampleEnvelope,
      now: 1,
    });
    enqueuePendingSignal({
      state: s,
      hostId: otherHost,
      envelope: { ...sampleEnvelope, toHostId: otherHost },
      now: 2,
    });
    expect(s.pendingSignals.get(hostId)?.length).toBe(2);
    expect(s.pendingSignals.get(otherHost)?.length).toBe(1);
  });

  it("drain returns and clears a host's bucket", () => {
    const s = createRelayState();
    enqueuePendingSignal({
      state: s,
      hostId,
      envelope: sampleEnvelope,
      now: 0,
    });
    const drained = drainPendingSignals({ state: s, hostId });
    expect(drained.length).toBe(1);
    expect(s.pendingSignals.has(hostId)).toBe(false);
  });

  it("sweep removes entries older than ttl and reports them", () => {
    const s = createRelayState();
    enqueuePendingSignal({
      state: s,
      hostId,
      envelope: sampleEnvelope,
      now: 1_000,
    });
    enqueuePendingSignal({
      state: s,
      hostId,
      envelope: sampleEnvelope,
      now: 5_000,
    });

    // now = 35_000 ms, ttl = 30_000 ms → 1_000 ms 時点のものだけ expire
    const result = sweepExpiredPendingSignals({
      state: s,
      now: 35_000,
      ttlMs: 30_000,
    });

    expect(result.expired.length).toBe(1);
    expect(result.expired[0]?.hostId).toBe(hostId);
    expect(s.pendingSignals.get(hostId)?.length).toBe(1);
  });

  it("sweep deletes the bucket entirely when all entries expired", () => {
    const s = createRelayState();
    enqueuePendingSignal({
      state: s,
      hostId,
      envelope: sampleEnvelope,
      now: 0,
    });
    sweepExpiredPendingSignals({ state: s, now: 1_000_000, ttlMs: 30_000 });
    expect(s.pendingSignals.has(hostId)).toBe(false);
  });

  it("sweep leaves untouched buckets alone", () => {
    const s = createRelayState();
    enqueuePendingSignal({
      state: s,
      hostId,
      envelope: sampleEnvelope,
      now: 100_000,
    });
    sweepExpiredPendingSignals({ state: s, now: 101_000, ttlMs: 30_000 });
    expect(s.pendingSignals.get(hostId)?.length).toBe(1);
  });
});

describe("turnCredentialIssuance", () => {
  it("recordTurnIssuance increments recent count within window", () => {
    const s = createRelayState();
    const r1 = recordTurnIssuance({
      state: s,
      userId,
      now: 1_000,
      windowMs: 60_000,
    });
    expect(r1.recentCount).toBe(1);

    const r2 = recordTurnIssuance({
      state: s,
      userId,
      now: 2_000,
      windowMs: 60_000,
    });
    expect(r2.recentCount).toBe(2);
  });

  it("entries outside the window are swept on record", () => {
    const s = createRelayState();
    recordTurnIssuance({ state: s, userId, now: 1_000, windowMs: 60_000 });
    recordTurnIssuance({ state: s, userId, now: 2_000, windowMs: 60_000 });

    const r = recordTurnIssuance({
      state: s,
      userId,
      // 90 秒後 — 最初の 2 件は窓外、record 自身が 1 件残る
      now: 91_000,
      windowMs: 60_000,
    });
    expect(r.recentCount).toBe(1);
  });

  it("peek returns 0 when no issuance recorded", () => {
    const s = createRelayState();
    const r = peekTurnRateLimit({
      state: s,
      userId,
      now: 0,
      windowMs: 60_000,
    });
    expect(r.recentCount).toBe(0);
  });

  it("peek sweeps expired and deletes empty windows", () => {
    const s = createRelayState();
    recordTurnIssuance({ state: s, userId, now: 1_000, windowMs: 60_000 });

    const r = peekTurnRateLimit({
      state: s,
      userId,
      now: 120_000,
      windowMs: 60_000,
    });
    expect(r.recentCount).toBe(0);
    expect(s.turnCredentialIssuance.has(userId)).toBe(false);
  });
});
