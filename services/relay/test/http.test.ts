import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, type RelayConfig } from "../src/config.js";
import {
  createRelayServer,
  startRelayServer,
  type StartedServer,
} from "../src/server.js";
import { createRelayState, type RelayState } from "../src/state.js";

const BOOTSTRAP_TOKEN = "test-bootstrap-http";
const TURN_SECRET = "test-turn-http";

const env = {
  TURN_SHARED_SECRET: TURN_SECRET,
  CODEX_LINK_HOST_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
};

let state: RelayState;
let config: RelayConfig;
let started: StartedServer;
let baseUrl: string;
let clockMs = 1_700_000_000_000;

const post = async (
  path: string,
  body: unknown,
  init?: RequestInit,
): Promise<Response> => {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  });
};

beforeEach(async () => {
  state = createRelayState();
  config = loadConfig({ env });
  clockMs = 1_700_000_000_000;
  const created = createRelayServer({
    state,
    config,
    now: () => clockMs,
  });
  started = await startRelayServer(created, "127.0.0.1", 0);
  baseUrl = `http://127.0.0.1:${started.port}`;
});

afterEach(async () => {
  await started.close();
});

describe("GET /api/health", () => {
  it("returns 200 with ok:true", async () => {
    const r = await fetch(`${baseUrl}/api/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });
});

describe("POST /api/host-bootstrap", () => {
  it("issues user + device + host on valid bootstrap token", async () => {
    const r = await post("/api/host-bootstrap", {
      bootstrapToken: BOOTSTRAP_TOKEN,
      hostDisplayName: "kite Mac",
      hostPlatform: "macos",
      devicePlatform: "macos",
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      userId: string;
      deviceId: string;
      sessionToken: string;
      host: { id: string; platform: string };
      hostAccess: { role: string };
    };
    expect(body.userId).toMatch(/^usr_/);
    expect(body.deviceId).toMatch(/^dev_/);
    expect(body.sessionToken.length).toBeGreaterThan(20);
    expect(body.host.platform).toBe("macos");
    expect(body.hostAccess.role).toBe("owner");
  });

  it("rejects invalid bootstrap token with 401", async () => {
    const r = await post("/api/host-bootstrap", {
      bootstrapToken: "wrong",
      hostDisplayName: "x",
      hostPlatform: "macos",
      devicePlatform: "macos",
    });
    expect(r.status).toBe(401);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_bootstrap_token");
  });

  it("rejects missing required fields with 400", async () => {
    const r = await post("/api/host-bootstrap", {
      bootstrapToken: BOOTSTRAP_TOKEN,
    });
    expect(r.status).toBe(400);
  });

  it("rejects invalid platform enum with 400", async () => {
    const r = await post("/api/host-bootstrap", {
      bootstrapToken: BOOTSTRAP_TOKEN,
      hostDisplayName: "x",
      hostPlatform: "freebsd",
      devicePlatform: "macos",
    });
    expect(r.status).toBe(400);
  });
});

describe("POST /api/device-session/register", () => {
  it("creates a new user + device and returns sessionToken", async () => {
    const r = await post("/api/device-session/register", {
      displayName: "kite iPhone",
      platform: "ios",
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      userId: string;
      deviceId: string;
      sessionToken: string;
    };
    expect(body.userId).toMatch(/^usr_/);
    expect(body.deviceId).toMatch(/^dev_/);
    expect(body.sessionToken.length).toBeGreaterThan(20);
  });
});

describe("POST /api/device-session/pair", () => {
  // owner bootstrap + 別 user 登録 → owner が pairing code を作って 別 user が redeem.
  const setupCode = async (): Promise<{ code: string; bearer: string }> => {
    // bootstrap で owner を作る.
    const bootR = await post("/api/host-bootstrap", {
      bootstrapToken: BOOTSTRAP_TOKEN,
      hostDisplayName: "kite Mac",
      hostPlatform: "macos",
      devicePlatform: "macos",
    });
    const boot = (await bootR.json()) as {
      deviceId: string;
    };

    // pairing code は HTTP で作る endpoint を Phase 2.5a では用意していない.
    // 直接 relay state を触って owner host への pairing code を作る (test util).
    const ownerDeviceId = boot.deviceId;
    const hostId = [...state.hosts.keys()][0]!;
    const { code } = (await import("../src/relay.js")).createPairingCode({
      state,
      hostId,
      createdByDeviceId: ownerDeviceId as unknown as typeof state.devices extends Map<infer K, unknown>
        ? K
        : never,
      now: clockMs,
      ttlMs: 60_000,
      maxAuditEvents: config.auditMaxEvents,
    });

    // 別 user 登録 → bearer 取得.
    const regR = await post("/api/device-session/register", {
      displayName: "kite iPhone",
      platform: "ios",
    });
    const reg = (await regR.json()) as { sessionToken: string };
    return { code, bearer: reg.sessionToken };
  };

  it("happy path: bearer + code → HostAccess granted", async () => {
    const { code, bearer } = await setupCode();
    const r = await post(
      "/api/device-session/pair",
      { pairingCode: code },
      { headers: { authorization: `Bearer ${bearer}` } },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      hostId: string;
      hostAccess: { role: string };
    };
    expect(body.hostId).toMatch(/^hst_/);
    expect(body.hostAccess.role).toBe("operator");
  });

  it("missing Authorization returns 401", async () => {
    const r = await post("/api/device-session/pair", {
      pairingCode: "ZZZZZZZZ",
    });
    expect(r.status).toBe(401);
  });

  it("invalid bearer returns 401", async () => {
    const r = await post(
      "/api/device-session/pair",
      { pairingCode: "ZZZZZZZZ" },
      { headers: { authorization: "Bearer not-a-real-token" } },
    );
    expect(r.status).toBe(401);
  });

  it("unknown code returns 404 with pairing_code_not_found", async () => {
    const { bearer } = await setupCode();
    const r = await post(
      "/api/device-session/pair",
      { pairingCode: "ZZZZZZZZ" },
      { headers: { authorization: `Bearer ${bearer}` } },
    );
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe("pairing_code_not_found");
  });
});

describe("misc", () => {
  it("unknown route returns 404", async () => {
    const r = await fetch(`${baseUrl}/api/nope`);
    expect(r.status).toBe(404);
  });

  it("oversize body returns 413", async () => {
    // maxHttpBodyBytes 既定 64 KiB を超える body を投げる.
    const huge = "x".repeat(80 * 1024);
    const r = await post("/api/host-bootstrap", {
      bootstrapToken: BOOTSTRAP_TOKEN,
      hostDisplayName: huge,
      hostPlatform: "macos",
      devicePlatform: "macos",
    });
    expect(r.status).toBe(413);
  });

  it("non-JSON body returns 400", async () => {
    const r = await fetch(`${baseUrl}/api/host-bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(r.status).toBe(400);
  });
});
