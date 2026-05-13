import { beforeEach, describe, expect, it } from "vitest";

import {
  asDeviceId,
  asHostId,
  asUserId,
  type SignalEnvelope,
} from "@codex-link/protocol/rendezvous";

import { bootstrapHost, createDevice, createUser } from "../src/relay.js";
import {
  drainBufferOnHostOnline,
  forwardSignal,
  SIGNAL_RATE_WINDOW_MS,
  sweepStaleBuffers,
} from "../src/signaling.js";
import {
  createRelayState,
  type RelayState,
} from "../src/state.js";

const MAX_AUDIT = 5_000;
const BOOTSTRAP_TOKEN = "test-bootstrap";

let state: RelayState;
let now = 1_700_000_000_000;
const tick = (ms: number): number => {
  now += ms;
  return now;
};

const setup = () => {
  // owner Host + iPhone user (other) — 2 つの user / device.
  const owner = bootstrapHost({
    state,
    providedBootstrapToken: BOOTSTRAP_TOKEN,
    configuredBootstrapToken: BOOTSTRAP_TOKEN,
    userDisplayName: "owner",
    hostDisplayName: "kite Mac",
    hostPlatform: "macos",
    devicePlatform: "macos",
    now,
    maxAuditEvents: MAX_AUDIT,
  });

  // iPhone を owner と同じ user の operator として redeem … は冗長なので、
  // ここでは owner を iPhone 側として扱う (owner の HostAccess を再利用).
  // 別端末ケースは relay.test.ts のペアリングテストで担保済み.
  return owner;
};

const offerEnvelope = (
  fromUserId: ReturnType<typeof asUserId>,
  fromDeviceId: ReturnType<typeof asDeviceId>,
  toHostId: ReturnType<typeof asHostId>,
  sentAt: number,
): SignalEnvelope => ({
  fromUserId,
  fromDeviceId,
  toHostId,
  signal: { kind: "offer", sdpBase64: "djA9MA==" },
  sentAt,
});

beforeEach(() => {
  state = createRelayState();
  now = 1_700_000_000_000;
});

describe("forwardSignal", () => {
  it("delivers immediately when host is online", () => {
    const { user, device, host } = setup();
    const env = offerEnvelope(user.id, device.id, host.id, now);

    const decision = forwardSignal({
      state,
      envelope: env,
      authenticatedUserId: user.id,
      authenticatedDeviceId: device.id,
      isHostOnline: () => true,
      ratePerMinute: 600,
      now,
      maxAuditEvents: MAX_AUDIT,
    });

    expect(decision.kind).toBe("delivered");
    expect(decision.hostId).toBe(host.id);
    expect(state.pendingSignals.has(host.id)).toBe(false);
    expect(state.auditEvents.at(-1)?.kind).toBe("signal.forwarded");
  });

  it("buffers when host is offline (TTL until drain)", () => {
    const { user, device, host } = setup();
    const env = offerEnvelope(user.id, device.id, host.id, now);

    const decision = forwardSignal({
      state,
      envelope: env,
      authenticatedUserId: user.id,
      authenticatedDeviceId: device.id,
      isHostOnline: () => false,
      ratePerMinute: 600,
      now,
      maxAuditEvents: MAX_AUDIT,
    });

    expect(decision.kind).toBe("buffered");
    expect(state.pendingSignals.get(host.id)?.length).toBe(1);
    expect(state.auditEvents.at(-1)?.kind).toBe("signal.buffered");
  });

  it("rejects identity mismatch (envelope.from* ≠ authenticated session)", () => {
    const { user, device, host } = setup();
    const env = offerEnvelope(
      asUserId("usr_attacker"),
      device.id,
      host.id,
      now,
    );

    expect(() =>
      forwardSignal({
        state,
        envelope: env,
        authenticatedUserId: user.id,
        authenticatedDeviceId: device.id,
        isHostOnline: () => true,
        ratePerMinute: 600,
        now,
        maxAuditEvents: MAX_AUDIT,
      }),
    ).toThrow(expect.objectContaining({ code: "signal_invalid" }));

    expect(state.auditEvents.at(-1)?.kind).toBe(
      "signal.dropped_identity_mismatch",
    );
  });

  it("rejects when user has no HostAccess to target host", () => {
    const { user, device } = setup();
    // 別の Host を bootstrap して、その host へ送ろうとする.
    const otherHostBootstrap = bootstrapHost({
      state,
      providedBootstrapToken: BOOTSTRAP_TOKEN,
      configuredBootstrapToken: BOOTSTRAP_TOKEN,
      userDisplayName: "other-owner",
      hostDisplayName: "other Mac",
      hostPlatform: "macos",
      devicePlatform: "macos",
      now: tick(1),
      maxAuditEvents: MAX_AUDIT,
    });

    const env = offerEnvelope(
      user.id,
      device.id,
      otherHostBootstrap.host.id,
      tick(1),
    );

    expect(() =>
      forwardSignal({
        state,
        envelope: env,
        authenticatedUserId: user.id,
        authenticatedDeviceId: device.id,
        isHostOnline: () => true,
        ratePerMinute: 600,
        now,
        maxAuditEvents: MAX_AUDIT,
      }),
    ).toThrow(expect.objectContaining({ code: "host_access_denied" }));

    expect(state.auditEvents.at(-1)?.kind).toBe("signal.dropped_no_access");
  });

  it("rate-limits a user after ratePerMinute forwards", () => {
    const { user, device, host } = setup();
    const limit = 4;
    for (let i = 0; i < limit; i++) {
      forwardSignal({
        state,
        envelope: offerEnvelope(user.id, device.id, host.id, now),
        authenticatedUserId: user.id,
        authenticatedDeviceId: device.id,
        isHostOnline: () => true,
        ratePerMinute: limit,
        now,
        maxAuditEvents: MAX_AUDIT,
      });
    }
    expect(() =>
      forwardSignal({
        state,
        envelope: offerEnvelope(user.id, device.id, host.id, now),
        authenticatedUserId: user.id,
        authenticatedDeviceId: device.id,
        isHostOnline: () => true,
        ratePerMinute: limit,
        now,
        maxAuditEvents: MAX_AUDIT,
      }),
    ).toThrow(expect.objectContaining({ code: "rate_limited" }));
    expect(state.auditEvents.at(-1)?.kind).toBe("signal.rate_limited");

    // 1 分 + 1ms 経過で再開可能.
    expect(() =>
      forwardSignal({
        state,
        envelope: offerEnvelope(user.id, device.id, host.id, now),
        authenticatedUserId: user.id,
        authenticatedDeviceId: device.id,
        isHostOnline: () => true,
        ratePerMinute: limit,
        now: now + SIGNAL_RATE_WINDOW_MS + 1,
        maxAuditEvents: MAX_AUDIT,
      }),
    ).not.toThrow();
  });

  it("Relay は SDP base64 / candidate base64 を decode したり audit に含めない", () => {
    const { user, device, host } = setup();
    // 識別しやすい base64 を仕込んでおく.
    const env: SignalEnvelope = {
      fromUserId: user.id,
      fromDeviceId: device.id,
      toHostId: host.id,
      signal: {
        kind: "offer",
        sdpBase64: "U0VOU0lUSVZFLVNEUC1QQVlMT0FE", // "SENSITIVE-SDP-PAYLOAD"
      },
      sentAt: now,
    };

    forwardSignal({
      state,
      envelope: env,
      authenticatedUserId: user.id,
      authenticatedDeviceId: device.id,
      isHostOnline: () => true,
      ratePerMinute: 600,
      now,
      maxAuditEvents: MAX_AUDIT,
    });

    // audit イベント全件を直列化して、payload の生 base64 が現れていないことを確認.
    const flat = JSON.stringify(state.auditEvents);
    expect(flat).not.toContain("SENSITIVE-SDP-PAYLOAD");
    expect(flat).not.toContain("U0VOU0lUSVZFLVNEUC1QQVlMT0FE");
  });
});

describe("drainBufferOnHostOnline", () => {
  it("delivers all buffered envelopes within TTL when host comes online", () => {
    const { user, device, host } = setup();
    // 3 件 buffer.
    for (let i = 0; i < 3; i++) {
      forwardSignal({
        state,
        envelope: offerEnvelope(user.id, device.id, host.id, now),
        authenticatedUserId: user.id,
        authenticatedDeviceId: device.id,
        isHostOnline: () => false,
        ratePerMinute: 600,
        now: tick(10),
        maxAuditEvents: MAX_AUDIT,
      });
    }

    const r = drainBufferOnHostOnline({
      state,
      hostId: host.id,
      now: tick(100),
      ttlMs: 30_000,
      maxAuditEvents: MAX_AUDIT,
    });
    expect(r.deliver.length).toBe(3);
    expect(r.dropped.length).toBe(0);
    expect(state.pendingSignals.has(host.id)).toBe(false);
    const kinds = state.auditEvents.map((e) => e.kind);
    // 少なくとも 3 件の delivered_from_buffer が記録される.
    expect(kinds.filter((k) => k === "signal.delivered_from_buffer").length).toBe(3);
  });

  it("drops envelopes older than TTL when host comes online", () => {
    const { user, device, host } = setup();
    // 1 つ古い、1 つ新しい.
    forwardSignal({
      state,
      envelope: offerEnvelope(user.id, device.id, host.id, now),
      authenticatedUserId: user.id,
      authenticatedDeviceId: device.id,
      isHostOnline: () => false,
      ratePerMinute: 600,
      now,
      maxAuditEvents: MAX_AUDIT,
    });
    const fresh = tick(40_000);
    forwardSignal({
      state,
      envelope: offerEnvelope(user.id, device.id, host.id, fresh),
      authenticatedUserId: user.id,
      authenticatedDeviceId: device.id,
      isHostOnline: () => false,
      ratePerMinute: 600,
      now: fresh,
      maxAuditEvents: MAX_AUDIT,
    });

    const r = drainBufferOnHostOnline({
      state,
      hostId: host.id,
      now: fresh + 1,
      ttlMs: 30_000,
      maxAuditEvents: MAX_AUDIT,
    });
    expect(r.deliver.length).toBe(1);
    expect(r.dropped.length).toBe(1);
    const kinds = state.auditEvents.map((e) => e.kind);
    expect(kinds).toContain("signal.expired");
    expect(kinds).toContain("signal.delivered_from_buffer");
  });

  it("returns empty arrays when there is nothing buffered for the host", () => {
    const { host } = setup();
    const r = drainBufferOnHostOnline({
      state,
      hostId: host.id,
      now,
      ttlMs: 30_000,
      maxAuditEvents: MAX_AUDIT,
    });
    expect(r.deliver).toEqual([]);
    expect(r.dropped).toEqual([]);
  });
});

describe("sweepStaleBuffers", () => {
  it("removes envelopes older than TTL and audits signal.expired", () => {
    const { user, device, host } = setup();
    forwardSignal({
      state,
      envelope: offerEnvelope(user.id, device.id, host.id, now),
      authenticatedUserId: user.id,
      authenticatedDeviceId: device.id,
      isHostOnline: () => false,
      ratePerMinute: 600,
      now,
      maxAuditEvents: MAX_AUDIT,
    });
    const r = sweepStaleBuffers({
      state,
      now: now + 60_000,
      ttlMs: 30_000,
      maxAuditEvents: MAX_AUDIT,
    });
    expect(r.expiredCount).toBe(1);
    expect(state.pendingSignals.has(host.id)).toBe(false);
    expect(
      state.auditEvents.filter((e) => e.kind === "signal.expired").length,
    ).toBe(1);
  });

  it("leaves fresh entries alone", () => {
    const { user, device, host } = setup();
    forwardSignal({
      state,
      envelope: offerEnvelope(user.id, device.id, host.id, now),
      authenticatedUserId: user.id,
      authenticatedDeviceId: device.id,
      isHostOnline: () => false,
      ratePerMinute: 600,
      now,
      maxAuditEvents: MAX_AUDIT,
    });
    const r = sweepStaleBuffers({
      state,
      now: now + 1_000,
      ttlMs: 30_000,
      maxAuditEvents: MAX_AUDIT,
    });
    expect(r.expiredCount).toBe(0);
    expect(state.pendingSignals.get(host.id)?.length).toBe(1);
  });
});
