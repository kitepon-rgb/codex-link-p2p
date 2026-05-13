// SignalingClient のインテグレーションテスト. 実 Relay をエフェメラル
// ポートで起動し、本物の WSS (ws:// for test) で疎通させる.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  asDeviceId,
  asHostId,
  asUserId,
  type RtcSignal,
} from "@codex-link/protocol/rendezvous";
import {
  createRelayServer,
  createRelayState,
  loadConfig,
  startRelayServer,
  type StartedServer,
} from "@codex-link/relay";

import { SignalingClient } from "../src/signaling-client.js";

const env = {
  TURN_SHARED_SECRET: "test-mac-host-turn",
  CODEX_LINK_HOST_BOOTSTRAP_TOKEN: "test-mac-host-bootstrap",
};

let started: StartedServer;
let relayState: ReturnType<typeof createRelayState>;
let baseUrl: string;
let clock = 1_700_000_000_000;

const post = async (path: string, body: unknown, init?: RequestInit) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  });

const bootstrap = async () => {
  const r = await post("/api/host-bootstrap", {
    bootstrapToken: env.CODEX_LINK_HOST_BOOTSTRAP_TOKEN,
    hostDisplayName: "kite Mac",
    hostPlatform: "macos",
    devicePlatform: "macos",
  });
  const body = (await r.json()) as {
    userId: string;
    deviceId: string;
    sessionToken: string;
    host: { id: string };
  };
  return {
    userId: asUserId(body.userId),
    deviceId: asDeviceId(body.deviceId),
    sessionToken: body.sessionToken,
    hostId: asHostId(body.host.id),
  };
};

const registerClient = async () => {
  const r = await post("/api/device-session/register", {
    displayName: "kite iPhone",
    platform: "ios",
  });
  const body = (await r.json()) as {
    userId: string;
    deviceId: string;
    sessionToken: string;
  };
  return {
    userId: asUserId(body.userId),
    deviceId: asDeviceId(body.deviceId),
    sessionToken: body.sessionToken,
  };
};

const pair = async (clientBearer: string, code: string) => {
  await post(
    "/api/device-session/pair",
    { pairingCode: code },
    { headers: { authorization: `Bearer ${clientBearer}` } },
  );
};

beforeEach(async () => {
  relayState = createRelayState();
  const config = loadConfig({ env });
  clock = 1_700_000_000_000;
  const created = createRelayServer({
    state: relayState,
    config,
    now: () => clock,
  });
  started = await startRelayServer(created, "127.0.0.1", 0);
  baseUrl = `http://127.0.0.1:${started.port}`;
});

afterEach(async () => {
  await started.close();
});

const waitFor = (cond: () => boolean, timeoutMs = 1_000): Promise<void> =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (cond()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitFor timed out (${timeoutMs}ms)`));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });

describe("SignalingClient", () => {
  it("connects, receives welcome, and surfaces state transitions", async () => {
    const host = await bootstrap();
    const events: string[] = [];
    let welcomedUserId: string | null = null;

    const client = new SignalingClient({
      relayUrl: baseUrl,
      sessionToken: host.sessionToken,
      handlers: {
        onStateChange: (s) => events.push(s),
        onWelcome: (info) => {
          welcomedUserId = info.userId as string;
        },
      },
    });
    client.start();

    await waitFor(() => welcomedUserId !== null);
    expect(welcomedUserId).toBe(host.userId as string);
    expect(events).toContain("connecting");
    expect(events).toContain("open");

    client.close();
    await waitFor(() => client.currentState() === "closed");
  });

  it("announce + iPhone signal.to_host arrives as signal.from_client", async () => {
    const host = await bootstrap();
    const incoming: RtcSignal[] = [];

    const hostClient = new SignalingClient({
      relayUrl: baseUrl,
      sessionToken: host.sessionToken,
      handlers: {
        onSignalFromClient: (m) => {
          incoming.push(m.envelope.signal);
        },
      },
    });
    hostClient.start();
    await waitFor(() => hostClient.currentState() === "open");
    hostClient.announce(host.hostId);
    // pairing code を作って iPhone を redeem.
    let code: string | null = null;
    hostClient["options"].handlers = {
      ...hostClient["options"].handlers,
      onPairingCodeIssued: (m) => {
        code = m.code;
      },
      onSignalFromClient: (m) => {
        incoming.push(m.envelope.signal);
      },
    };
    hostClient.createPairingCode(host.hostId);
    await waitFor(() => code !== null);

    const iphone = await registerClient();
    await pair(iphone.sessionToken, code as unknown as string);

    // iPhone を WS で接続して signal.to_host を送る.
    const iphoneClient = new SignalingClient({
      relayUrl: baseUrl,
      sessionToken: iphone.sessionToken,
      handlers: {},
    });
    iphoneClient.start();
    await waitFor(() => iphoneClient.currentState() === "open");
    iphoneClient.sendSignalToHost(
      host.hostId,
      { kind: "offer", sdpBase64: "djA9MA==" },
      clock,
    );

    await waitFor(() => incoming.length > 0);
    expect(incoming[0]?.kind).toBe("offer");

    iphoneClient.close();
    hostClient.close();
  });

  it("turn credential request → onTurnCredential fired with payload", async () => {
    const host = await bootstrap();
    let received: { username: string; password: string } | null = null;
    const client = new SignalingClient({
      relayUrl: baseUrl,
      sessionToken: host.sessionToken,
      handlers: {
        onTurnCredential: (m) => {
          received = m.credential;
        },
      },
    });
    client.start();
    await waitFor(() => client.currentState() === "open");
    client.requestTurnCredential(host.hostId);
    await waitFor(() => received !== null);
    expect(received).not.toBeNull();
    expect((received as unknown as { username: string }).username).toMatch(
      /:usr_/,
    );
    client.close();
  });

  it("pairing_code.create returns plaintext code via onPairingCodeIssued", async () => {
    const host = await bootstrap();
    let issued: string | null = null;
    const client = new SignalingClient({
      relayUrl: baseUrl,
      sessionToken: host.sessionToken,
      handlers: {
        onPairingCodeIssued: (m) => {
          issued = m.code;
        },
      },
    });
    client.start();
    await waitFor(() => client.currentState() === "open");
    client.createPairingCode(host.hostId);
    await waitFor(() => issued !== null);
    expect(issued).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    client.close();
  });

  it("invalid session token leads to closed state without leaking infinite reconnect", async () => {
    const errors: string[] = [];
    const states: string[] = [];
    const client = new SignalingClient({
      relayUrl: baseUrl,
      sessionToken: "definitely-not-a-real-token",
      handlers: {
        onStateChange: (s) => states.push(s),
        onLog: (lvl, msg) => {
          if (lvl === "warn" || lvl === "error") errors.push(msg);
        },
      },
      reconnectMinMs: 20,
      reconnectMaxMs: 80,
    });
    client.start();
    // 401 で WS open しないため、connecting → reconnecting を観測できれば良い.
    await waitFor(
      () => states.includes("reconnecting") || states.includes("closed"),
      1_500,
    );
    client.close();
    expect(states).toContain("connecting");
    expect(errors.length).toBeGreaterThan(0);
  });
});

void asDeviceId;
