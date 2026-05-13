import { describe, expect, expectTypeOf, it } from "vitest";

import {
  asDeviceId,
  asHostId,
  asUserId,
  type DeviceId,
  type Host,
  type HostAccess,
  type HostId,
  type HostPairingCode,
  type HostPresence,
  type RtcIceCandidate,
  type RtcSignal,
  type RtcSignalOffer,
  type SignalEnvelope,
  type TurnCredential,
  type UserId,
} from "../src/rendezvous.js";

describe("branded IDs", () => {
  it("helper turns raw string into branded ID at the value level", () => {
    const u = asUserId("user-abc");
    const d = asDeviceId("device-xyz");
    const h = asHostId("host-1");

    expect(u).toBe("user-abc");
    expect(d).toBe("device-xyz");
    expect(h).toBe("host-1");
  });

  it("brand types are distinct from raw string and from each other", () => {
    expectTypeOf<UserId>().not.toEqualTypeOf<string>();
    expectTypeOf<DeviceId>().not.toEqualTypeOf<string>();
    expectTypeOf<HostId>().not.toEqualTypeOf<string>();
    expectTypeOf<UserId>().not.toEqualTypeOf<DeviceId>();
    expectTypeOf<DeviceId>().not.toEqualTypeOf<HostId>();
  });

  it("a raw string literal cannot be assigned to a branded ID", () => {
    // @ts-expect-error — UserId must be minted via asUserId, not raw string
    const _bad: UserId = "user-abc";
    void _bad;
  });

  it("a UserId is not assignable to a DeviceId even though both wrap string", () => {
    const u = asUserId("user-1");
    // @ts-expect-error — UserId is not a DeviceId
    const _bad: DeviceId = u;
    void _bad;
  });
});

describe("SignalEnvelope", () => {
  const userId = asUserId("user-1");
  const deviceId = asDeviceId("device-1");
  const hostId = asHostId("host-1");

  const sampleOffer: RtcSignalOffer = {
    kind: "offer",
    // Relay にとっては opaque な base64. ここでは "v=0..." を base64 した想定の任意文字列
    sdpBase64: "djA9MA==",
  };

  it("JSON round-trips while preserving the opaque base64 payload", () => {
    const env: SignalEnvelope = {
      fromUserId: userId,
      fromDeviceId: deviceId,
      toHostId: hostId,
      signal: sampleOffer,
      sentAt: 1_700_000_000_000,
    };

    const decoded = JSON.parse(JSON.stringify(env)) as SignalEnvelope;

    expect(decoded.fromUserId).toBe(userId);
    expect(decoded.toHostId).toBe(hostId);
    expect(decoded.signal.kind).toBe("offer");
    if (decoded.signal.kind === "offer") {
      expect(decoded.signal.sdpBase64).toBe(sampleOffer.sdpBase64);
    }
  });

  it("ICE candidate envelope preserves null sdpMid / sdpMLineIndex", () => {
    const ice: RtcIceCandidate = {
      kind: "ice",
      candidateBase64: "Y2FuZGlkYXRlOjA=",
      sdpMid: null,
      sdpMLineIndex: null,
    };
    const env: SignalEnvelope = {
      fromUserId: userId,
      fromDeviceId: deviceId,
      toHostId: hostId,
      signal: ice,
      sentAt: 1_700_000_000_000,
    };

    const decoded = JSON.parse(JSON.stringify(env)) as SignalEnvelope;
    expect(decoded.signal.kind).toBe("ice");
    if (decoded.signal.kind === "ice") {
      expect(decoded.signal.sdpMid).toBeNull();
      expect(decoded.signal.sdpMLineIndex).toBeNull();
    }
  });

  it("discriminant narrowing covers all RtcSignal variants exhaustively", () => {
    const classify = (s: RtcSignal): string => {
      switch (s.kind) {
        case "offer":
          return "offer";
        case "answer":
          return "answer";
        case "ice":
          return "ice";
        case "connectionState":
          return s.state;
      }
      // Exhaustiveness check — if a new variant is added without updating
      // this switch, TS errors here.
      const _never: never = s;
      return _never;
    };

    expect(classify(sampleOffer)).toBe("offer");
    expect(classify({ kind: "connectionState", state: "connected" })).toBe(
      "connected",
    );
  });
});

describe("TurnCredential", () => {
  it("expiresAt comparison classifies expired vs live", () => {
    const now = 1_700_000_000_000;
    const live: TurnCredential = {
      username: `${(now + 60_000) / 1000 | 0}:user-1`,
      password: "cGFzc3dk",
      ttlSec: 300,
      expiresAt: now + 60_000,
      urls: ["turn:turn.example:3478"],
    };
    const expired: TurnCredential = { ...live, expiresAt: now - 1_000 };

    expect(live.expiresAt > now).toBe(true);
    expect(expired.expiresAt > now).toBe(false);
  });
});

describe("Registry types compile with branded IDs", () => {
  it("Host / HostAccess / HostPairingCode accept branded IDs only", () => {
    const userId = asUserId("user-1");
    const deviceId = asDeviceId("device-1");
    const hostId = asHostId("host-1");

    const host: Host = {
      id: hostId,
      ownerUserId: userId,
      displayName: "kite Mac",
      platform: "macos",
      createdAt: 0,
    };
    const access: HostAccess = {
      hostId,
      userId,
      role: "owner",
      grantedAt: 0,
    };
    const pairing: HostPairingCode = {
      hostId,
      codeHash: "0".repeat(64),
      expiresAt: 1,
      createdByDeviceId: deviceId,
      redeemed: false,
    };

    expect(host.platform).toBe("macos");
    expect(access.role).toBe("owner");
    expect(pairing.redeemed).toBe(false);
  });
});

describe("HostPresence (signaling-level, NOT a DataChannel event)", () => {
  it("discriminates online / offline", () => {
    const events: HostPresence[] = [
      { kind: "host.online", hostId: asHostId("h-1"), at: 1 },
      { kind: "host.offline", hostId: asHostId("h-1"), at: 2 },
    ];
    expect(events.map((e) => e.kind)).toEqual(["host.online", "host.offline"]);
  });
});
