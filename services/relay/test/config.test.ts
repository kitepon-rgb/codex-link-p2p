import { describe, expect, it } from "vitest";

import { RelayConfigError, loadConfig } from "../src/config.js";

const baseEnv = (overrides: Record<string, string | undefined> = {}) => ({
  TURN_SHARED_SECRET: "test-secret",
  ...overrides,
});

describe("loadConfig", () => {
  it("throws when TURN_SHARED_SECRET is missing", () => {
    expect(() => loadConfig({ env: {} })).toThrow(RelayConfigError);
  });

  it("throws when TURN_SHARED_SECRET is empty string", () => {
    expect(() => loadConfig({ env: { TURN_SHARED_SECRET: "" } })).toThrow(
      /required env var missing/,
    );
  });

  it("returns sane defaults when only the required secret is set", () => {
    const cfg = loadConfig({ env: baseEnv() });
    expect(cfg.turnSharedSecret).toBe("test-secret");
    expect(cfg.relayUrl).toBe("http://127.0.0.1:3000");
    expect(cfg.bindHost).toBe("0.0.0.0");
    expect(cfg.port).toBe(3000);
    expect(cfg.turnUrls).toEqual(["stun:stun.l.google.com:19302"]);
    expect(cfg.turnRealm).toBe("codex-link-p2p.local");
    expect(cfg.turnCredentialTtlSec).toBe(300);
    expect(cfg.pendingSignalTtlMs).toBe(30_000);
    expect(cfg.maxHttpBodyBytes).toBe(64 * 1024);
    expect(cfg.maxWebsocketPayloadBytes).toBe(128 * 1024);
    expect(cfg.rateLimit.turnCredentialPerMinute).toBe(30);
    expect(cfg.rateLimit.signalForwardPerMinute).toBe(600);
    expect(cfg.rateLimit.pairingCreatePerMinute).toBe(10);
  });

  it("parses comma-separated TURN_URLS and trims whitespace", () => {
    const cfg = loadConfig({
      env: baseEnv({
        TURN_URLS:
          "stun:stun.l.google.com:19302, turn:turn.example:3478 , turns:turn.example:5349",
      }),
    });
    expect(cfg.turnUrls).toEqual([
      "stun:stun.l.google.com:19302",
      "turn:turn.example:3478",
      "turns:turn.example:5349",
    ]);
  });

  it("rejects TURN_URLS with non-stun/turn schemes", () => {
    expect(() =>
      loadConfig({ env: baseEnv({ TURN_URLS: "http://nope" }) }),
    ).toThrow(/TURN_URLS entry must start with/);
  });

  it("rejects empty TURN_URLS", () => {
    expect(() =>
      loadConfig({ env: baseEnv({ TURN_URLS: "  ,  ,  " }) }),
    ).toThrow(/must contain at least one URL/);
  });

  it("rejects non-integer numeric env", () => {
    expect(() =>
      loadConfig({ env: baseEnv({ PORT: "abc" }) }),
    ).toThrow(/must be an integer/);
  });

  it("rejects out-of-range PORT", () => {
    expect(() => loadConfig({ env: baseEnv({ PORT: "0" }) })).toThrow(
      /must be >= 1/,
    );
    expect(() =>
      loadConfig({ env: baseEnv({ PORT: "99999" }) }),
    ).toThrow(/must be <= 65535/);
  });

  it("clamps TURN_CREDENTIAL_TTL_SEC into [30, 86400]", () => {
    expect(() =>
      loadConfig({ env: baseEnv({ TURN_CREDENTIAL_TTL_SEC: "10" }) }),
    ).toThrow(/must be >= 30/);
    expect(() =>
      loadConfig({
        env: baseEnv({ TURN_CREDENTIAL_TTL_SEC: String(86400 + 1) }),
      }),
    ).toThrow(/must be <= 86400/);
  });
});
