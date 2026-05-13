import { beforeEach, describe, expect, it } from "vitest";

import { asDeviceId, asUserId, asHostId } from "@codex-link/protocol/rendezvous";

import {
  assertHostAccess,
  authenticateDeviceSession,
  bootstrapHost,
  createDevice,
  createPairingCode,
  createUser,
  redeemPairingCode,
  RelayError,
  revokeDeviceSession,
  revokeHostAccess,
} from "../src/relay.js";
import {
  createRelayState,
  hostAccessKey,
  type RelayState,
} from "../src/state.js";

const MAX_AUDIT = 1_000;
const BOOTSTRAP_TOKEN = "test-bootstrap-token";

let state: RelayState;
let now = 1_700_000_000_000;
const advance = (ms: number): number => {
  now += ms;
  return now;
};

beforeEach(() => {
  state = createRelayState();
  now = 1_700_000_000_000;
});

describe("createUser", () => {
  it("registers a user and emits a user.created audit event", () => {
    const { user } = createUser({ state, now, maxAuditEvents: MAX_AUDIT });
    expect(state.users.get(user.id)).toEqual(user);
    expect(state.auditEvents.at(-1)?.kind).toBe("user.created");
    expect(state.auditEvents.at(-1)?.outcome).toBe("ok");
  });
});

describe("createDevice", () => {
  it("creates a device, returns a one-time session token, stores only its hash", () => {
    const { user } = createUser({ state, now, maxAuditEvents: MAX_AUDIT });
    const { device, sessionToken } = createDevice({
      state,
      userId: user.id,
      displayName: "kite Mac",
      platform: "macos",
      now,
      maxAuditEvents: MAX_AUDIT,
    });

    // 平文 token は state には現れないこと
    const stored = state.devices.get(device.id);
    expect(stored).toBeDefined();
    expect(stored?.sessionTokenHash).toBeDefined();
    const flat = JSON.stringify(stored);
    expect(flat).not.toContain(sessionToken);
    // 平文の token は 32 byte → base64url 43 chars
    expect(sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rejects unknown userId", () => {
    expect(() =>
      createDevice({
        state,
        userId: asUserId("unknown"),
        displayName: "x",
        platform: "ios",
        now,
        maxAuditEvents: MAX_AUDIT,
      }),
    ).toThrow(RelayError);
  });
});

describe("authenticateDeviceSession", () => {
  it("returns the device record for a valid token", () => {
    const { user } = createUser({ state, now, maxAuditEvents: MAX_AUDIT });
    const { device, sessionToken } = createDevice({
      state,
      userId: user.id,
      displayName: "kite Mac",
      platform: "macos",
      now,
      maxAuditEvents: MAX_AUDIT,
    });

    const r = authenticateDeviceSession({
      state,
      providedSessionToken: sessionToken,
      now: advance(1_000),
    });
    expect(r.id).toBe(device.id);
    expect(r.lastSeenAt).toBe(now);
  });

  it("rejects an unknown token with invalid_session_token", () => {
    expect(() =>
      authenticateDeviceSession({
        state,
        providedSessionToken: "definitely-not-real-token",
        now,
      }),
    ).toThrow(
      expect.objectContaining({ code: "invalid_session_token" }),
    );
  });

  it("rejects a revoked device", () => {
    const { user } = createUser({ state, now, maxAuditEvents: MAX_AUDIT });
    const { device, sessionToken } = createDevice({
      state,
      userId: user.id,
      displayName: "x",
      platform: "macos",
      now,
      maxAuditEvents: MAX_AUDIT,
    });
    revokeDeviceSession({
      state,
      deviceId: device.id,
      now: advance(1),
      maxAuditEvents: MAX_AUDIT,
    });
    expect(() =>
      authenticateDeviceSession({
        state,
        providedSessionToken: sessionToken,
        now: advance(1),
      }),
    ).toThrow(
      // revoke は index も消すので、結果として invalid_session_token になる.
      expect.objectContaining({ code: "invalid_session_token" }),
    );
  });
});

describe("bootstrapHost", () => {
  it("creates user + device + host + owner access on valid token", () => {
    const r = bootstrapHost({
      state,
      providedBootstrapToken: BOOTSTRAP_TOKEN,
      configuredBootstrapToken: BOOTSTRAP_TOKEN,
      userDisplayName: "kite",
      hostDisplayName: "kite Mac",
      hostPlatform: "macos",
      devicePlatform: "macos",
      now,
      maxAuditEvents: MAX_AUDIT,
    });
    expect(state.users.get(r.user.id)).toBeDefined();
    expect(state.devices.get(r.device.id)).toBeDefined();
    expect(state.hosts.get(r.host.id)).toBeDefined();
    expect(state.hostAccess.get(hostAccessKey(r.host.id, r.user.id))?.role).toBe(
      "owner",
    );
    expect(r.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const kinds = state.auditEvents.map((e) => e.kind);
    expect(kinds).toContain("host.bootstrap");
    expect(kinds).toContain("host.access.granted");
  });

  it("denies on bootstrap token mismatch and audits a denied event", () => {
    expect(() =>
      bootstrapHost({
        state,
        providedBootstrapToken: "wrong",
        configuredBootstrapToken: BOOTSTRAP_TOKEN,
        userDisplayName: "x",
        hostDisplayName: "x",
        hostPlatform: "macos",
        devicePlatform: "macos",
        now,
        maxAuditEvents: MAX_AUDIT,
      }),
    ).toThrow(
      expect.objectContaining({ code: "invalid_bootstrap_token" }),
    );
    const last = state.auditEvents.at(-1);
    expect(last?.kind).toBe("host.bootstrap");
    expect(last?.outcome).toBe("denied");
    expect(state.users.size).toBe(0);
    expect(state.hosts.size).toBe(0);
  });
});

describe("pairing code flow", () => {
  // Host owner を bootstrap して、別 User がその code を redeem するシナリオ.
  const setupHostAndOtherUser = () => {
    const bs = bootstrapHost({
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
    const otherUser = createUser({
      state,
      now: advance(1),
      maxAuditEvents: MAX_AUDIT,
    }).user;
    const otherDevice = createDevice({
      state,
      userId: otherUser.id,
      displayName: "kite iPhone",
      platform: "ios",
      now: advance(1),
      maxAuditEvents: MAX_AUDIT,
    }).device;
    return { ownerUser: bs.user, ownerDevice: bs.device, host: bs.host, otherUser, otherDevice };
  };

  it("createPairingCode stores only a hash, returns plaintext once", () => {
    const { host, ownerDevice } = setupHostAndOtherUser();
    const { code, record } = createPairingCode({
      state,
      hostId: host.id,
      createdByDeviceId: ownerDevice.id,
      now: advance(1),
      ttlMs: 60_000,
      maxAuditEvents: MAX_AUDIT,
    });
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(state.pairingCodes.get(host.id)?.codeHash).toBe(record.codeHash);
    expect(state.pairingCodes.get(host.id)?.codeHash).not.toBe(code);
    expect(state.pairingCodes.get(host.id)?.redeemed).toBe(false);
  });

  it("redeem grants HostAccess to redeeming user, marks code redeemed", () => {
    const { host, ownerDevice, otherUser, otherDevice } =
      setupHostAndOtherUser();
    const { code } = createPairingCode({
      state,
      hostId: host.id,
      createdByDeviceId: ownerDevice.id,
      now: advance(1),
      ttlMs: 60_000,
      maxAuditEvents: MAX_AUDIT,
    });

    const r = redeemPairingCode({
      state,
      providedCode: code,
      redeemingUserId: otherUser.id,
      redeemingDeviceId: otherDevice.id,
      role: "operator",
      now: advance(1_000),
      maxAuditEvents: MAX_AUDIT,
    });
    expect(r.hostId).toBe(host.id);
    expect(r.hostAccess.role).toBe("operator");
    expect(state.pairingCodes.get(host.id)?.redeemed).toBe(true);
  });

  it("re-redeem is rejected with pairing_code_redeemed", () => {
    const { host, ownerDevice, otherUser, otherDevice } =
      setupHostAndOtherUser();
    const { code } = createPairingCode({
      state,
      hostId: host.id,
      createdByDeviceId: ownerDevice.id,
      now: advance(1),
      ttlMs: 60_000,
      maxAuditEvents: MAX_AUDIT,
    });
    redeemPairingCode({
      state,
      providedCode: code,
      redeemingUserId: otherUser.id,
      redeemingDeviceId: otherDevice.id,
      role: "operator",
      now: advance(1_000),
      maxAuditEvents: MAX_AUDIT,
    });
    expect(() =>
      redeemPairingCode({
        state,
        providedCode: code,
        redeemingUserId: otherUser.id,
        redeemingDeviceId: otherDevice.id,
        role: "operator",
        now: advance(1),
        maxAuditEvents: MAX_AUDIT,
      }),
    ).toThrow(expect.objectContaining({ code: "pairing_code_redeemed" }));
  });

  it("expired code is rejected with pairing_code_expired", () => {
    const { host, ownerDevice, otherUser, otherDevice } =
      setupHostAndOtherUser();
    const { code } = createPairingCode({
      state,
      hostId: host.id,
      createdByDeviceId: ownerDevice.id,
      now: advance(1),
      ttlMs: 60_000,
      maxAuditEvents: MAX_AUDIT,
    });
    expect(() =>
      redeemPairingCode({
        state,
        providedCode: code,
        redeemingUserId: otherUser.id,
        redeemingDeviceId: otherDevice.id,
        role: "operator",
        now: advance(60_001),
        maxAuditEvents: MAX_AUDIT,
      }),
    ).toThrow(expect.objectContaining({ code: "pairing_code_expired" }));
  });

  it("unknown code is rejected with pairing_code_not_found", () => {
    const { otherUser, otherDevice } = setupHostAndOtherUser();
    expect(() =>
      redeemPairingCode({
        state,
        providedCode: "Z9Z9Z9Z9",
        redeemingUserId: otherUser.id,
        redeemingDeviceId: otherDevice.id,
        role: "operator",
        now: advance(1),
        maxAuditEvents: MAX_AUDIT,
      }),
    ).toThrow(expect.objectContaining({ code: "pairing_code_not_found" }));
  });

  it("redeem tolerates Crockford typos (I/L/O/U and dashes)", () => {
    const { host, ownerDevice, otherUser, otherDevice } =
      setupHostAndOtherUser();
    const { code } = createPairingCode({
      state,
      hostId: host.id,
      createdByDeviceId: ownerDevice.id,
      now: advance(1),
      ttlMs: 60_000,
      maxAuditEvents: MAX_AUDIT,
    });
    // Crockford normalize は I→1, L→1, O→0, U→V を行うが、code は元から
    // I/L/O/U を含まない alphabet なので、本テストは「dashes と空白」が
    // 削除されること、および小文字も大文字化されることを確認する.
    const messy = ` ${code.slice(0, 4)}-${code.slice(4).toLowerCase()} `;
    const r = redeemPairingCode({
      state,
      providedCode: messy,
      redeemingUserId: otherUser.id,
      redeemingDeviceId: otherDevice.id,
      role: "operator",
      now: advance(1_000),
      maxAuditEvents: MAX_AUDIT,
    });
    expect(r.hostId).toBe(host.id);
  });
});

describe("assertHostAccess / revokeHostAccess", () => {
  it("succeeds for the owner just bootstrapped", () => {
    const r = bootstrapHost({
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
    const a = assertHostAccess({
      state,
      userId: r.user.id,
      hostId: r.host.id,
    });
    expect(a.role).toBe("owner");
  });

  it("throws host_access_denied for an unrelated user", () => {
    const r = bootstrapHost({
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
    expect(() =>
      assertHostAccess({
        state,
        userId: asUserId("usr_other"),
        hostId: r.host.id,
      }),
    ).toThrow(expect.objectContaining({ code: "host_access_denied" }));
  });

  it("revokeHostAccess removes the grant and audits", () => {
    const r = bootstrapHost({
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
    revokeHostAccess({
      state,
      userId: r.user.id,
      hostId: r.host.id,
      now: advance(1),
      maxAuditEvents: MAX_AUDIT,
    });
    expect(() =>
      assertHostAccess({
        state,
        userId: r.user.id,
        hostId: r.host.id,
      }),
    ).toThrow(expect.objectContaining({ code: "host_access_denied" }));
    expect(state.auditEvents.at(-1)?.kind).toBe("host.access.revoked");
  });
});

describe("invariants", () => {
  it("device session token never appears in any state record", () => {
    const r = bootstrapHost({
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
    const stateJson = JSON.stringify(state, (_k, v) => {
      if (v instanceof Map) return [...v.entries()];
      return v;
    });
    expect(stateJson).not.toContain(r.sessionToken);
  });

  it("pairing code plaintext never appears in any state record", () => {
    const r = bootstrapHost({
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
    const { code } = createPairingCode({
      state,
      hostId: r.host.id,
      createdByDeviceId: r.device.id,
      now: advance(1),
      ttlMs: 60_000,
      maxAuditEvents: MAX_AUDIT,
    });
    const stateJson = JSON.stringify(state, (_k, v) => {
      if (v instanceof Map) return [...v.entries()];
      return v;
    });
    expect(stateJson).not.toContain(code);
  });
});
