import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WS, { type WebSocket as WSClient } from "ws";

import {
  asDeviceId,
  asHostId,
  asUserId,
} from "@codex-link/protocol/rendezvous";

import { loadConfig, type RelayConfig } from "../src/config.js";
import {
  createRelayServer,
  startRelayServer,
  type StartedServer,
} from "../src/server.js";
import { createRelayState, type RelayState } from "../src/state.js";
import type { WsInbound, WsOutbound } from "../src/ws-messages.js";

const env = {
  TURN_SHARED_SECRET: "test-turn-ws",
  CODEX_LINK_HOST_BOOTSTRAP_TOKEN: "test-bootstrap-ws",
};

let state: RelayState;
let config: RelayConfig;
let started: StartedServer;
let baseUrl: string;
let clockMs = 1_700_000_000_000;

const post = async (path: string, body: unknown, init?: RequestInit) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  });

// Open event 前に listener を attach して welcome を取りこぼさない helper.
interface ClientHandle {
  readonly ws: WSClient;
  next: (timeoutMs?: number) => Promise<WsOutbound>;
}

const makeClientHandle = (ws: WSClient): ClientHandle => {
  const buffered: WsOutbound[] = [];
  const waiters: ((m: WsOutbound) => void)[] = [];
  ws.on("message", (raw) => {
    let msg: WsOutbound;
    try {
      msg =
        typeof raw === "string"
          ? (JSON.parse(raw) as WsOutbound)
          : (JSON.parse(raw.toString()) as WsOutbound);
    } catch {
      return;
    }
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(msg);
    else buffered.push(msg);
  });
  return {
    ws,
    next: (timeoutMs = 1_000) =>
      new Promise<WsOutbound>((resolve, reject) => {
        const fromBuf = buffered.shift();
        if (fromBuf !== undefined) {
          resolve(fromBuf);
          return;
        }
        const t = setTimeout(() => {
          reject(new Error(`ws.next timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        waiters.push((m) => {
          clearTimeout(t);
          resolve(m);
        });
      }),
  };
};

const wsConnect = (token: string): Promise<ClientHandle> =>
  new Promise((resolve, reject) => {
    const url = baseUrl.replace(/^http/, "ws") + "/api/relay";
    const ws = new WS(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    // open 前に listener を attach.
    const handle = makeClientHandle(ws);
    ws.once("open", () => resolve(handle));
    ws.once("error", reject);
  });

const send = (handle: ClientHandle, msg: WsInbound): void => {
  handle.ws.send(JSON.stringify(msg));
};

const closeWs = async (handle: ClientHandle): Promise<void> => {
  if (handle.ws.readyState === handle.ws.OPEN) {
    await new Promise<void>((resolve) => {
      handle.ws.once("close", () => resolve());
      handle.ws.close();
    });
  }
};

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
    host: { id: asHostId(body.host.id) },
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
  const r = await post(
    "/api/device-session/pair",
    { pairingCode: code },
    { headers: { authorization: `Bearer ${clientBearer}` } },
  );
  return (await r.json()) as { hostId: string };
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

describe("WS upgrade auth", () => {
  it("accepts a valid Bearer session token and sends welcome", async () => {
    const reg = await registerClient();
    const ws = await wsConnect(reg.sessionToken);
    const welcome = await ws.next();
    expect(welcome.type).toBe("welcome");
    if (welcome.type === "welcome") {
      expect(welcome.userId).toBe(reg.userId);
      expect(welcome.deviceId).toBe(reg.deviceId);
    }
    await closeWs(ws);
  });

  it("rejects upgrade with missing Bearer (401, no WS open)", async () => {
    const url = baseUrl.replace(/^http/, "ws") + "/api/relay";
    const opening = new WS(url);
    await new Promise<void>((resolve, reject) => {
      opening.once("open", () => {
        opening.close();
        reject(new Error("WS should not open without Bearer"));
      });
      opening.once("error", () => resolve());
      opening.once("unexpected-response", (_req, res) => {
        expect(res.statusCode).toBe(401);
        resolve();
      });
    });
  });

  it("accepts access_token query string fallback", async () => {
    const reg = await registerClient();
    const url =
      baseUrl.replace(/^http/, "ws") +
      `/api/relay?access_token=${encodeURIComponent(reg.sessionToken)}`;
    const ws = new WS(url);
    const handle = makeClientHandle(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const welcome = await handle.next();
    expect(welcome.type).toBe("welcome");
    await closeWs(handle);
  });
});

describe("WS signaling: client → Host (online)", () => {
  it("delivers signal.to_host to an announced Host as signal.from_client", async () => {
    const host = await bootstrap();
    // Pairing code を作って iPhone を redeem.
    const hostWs = await wsConnect(host.sessionToken);
    await hostWs.next(); // welcome
    send(hostWs, {
      type: "pairing_code.create",
      hostId: asHostId(host.host.id),
    });
    const issued = await hostWs.next();
    expect(issued.type).toBe("pairing_code.issued");
    if (issued.type !== "pairing_code.issued") throw new Error("unreachable");

    const clientReg = await registerClient();
    await pair(clientReg.sessionToken, issued.code);

    // Host が announce.
    send(hostWs, { type: "host.announce", hostId: host.host.id });

    const clientWs = await wsConnect(clientReg.sessionToken);
    await clientWs.next(); // welcome

    // Host が次に受け取るメッセージを await し、その後 client が send.
    const hostNext = hostWs.next();
    send(clientWs, {
      type: "signal.to_host",
      hostId: host.host.id,
      signal: { kind: "offer", sdpBase64: "djA9MA==" },
      sentAt: clockMs,
    });
    const forwarded = await hostNext;
    expect(forwarded.type).toBe("signal.from_client");
    if (forwarded.type === "signal.from_client") {
      expect(forwarded.envelope.fromUserId).toBe(clientReg.userId);
      expect(forwarded.envelope.fromDeviceId).toBe(clientReg.deviceId);
      expect(forwarded.envelope.toHostId).toBe(host.host.id);
      expect(forwarded.envelope.signal.kind).toBe("offer");
    }

    await Promise.all([closeWs(hostWs), closeWs(clientWs)]);
  });

  it("buffers signal.to_host when Host is offline and drains on host.announce", async () => {
    const host = await bootstrap();
    // Host owner で pairing code を作るために一旦 WS 接続 → code → close.
    const ownerWs1 = await wsConnect(host.sessionToken);
    await ownerWs1.next(); // welcome
    send(ownerWs1, { type: "pairing_code.create", hostId: host.host.id });
    const issued = await ownerWs1.next();
    if (issued.type !== "pairing_code.issued") throw new Error("unreachable");
    await closeWs(ownerWs1);

    const clientReg = await registerClient();
    await pair(clientReg.sessionToken, issued.code);

    // この時点で Host は offline. client が signal を送ると buffer される.
    const clientWs = await wsConnect(clientReg.sessionToken);
    await clientWs.next();
    send(clientWs, {
      type: "signal.to_host",
      hostId: host.host.id,
      signal: { kind: "offer", sdpBase64: "djA9MA==" },
      sentAt: clockMs,
    });
    // 少し待って host が再接続.
    await new Promise((r) => setTimeout(r, 50));
    expect(state.pendingSignals.get(host.host.id as never)?.length).toBe(1);

    const hostWs = await wsConnect(host.sessionToken);
    await hostWs.next(); // welcome
    const hostNext = hostWs.next();
    send(hostWs, { type: "host.announce", hostId: host.host.id });
    const drained = await hostNext;
    expect(drained.type).toBe("signal.from_client");

    await Promise.all([closeWs(hostWs), closeWs(clientWs)]);
  });
});

describe("WS signaling: Host → client", () => {
  it("forwards signal.to_client as signal.from_host to the target device", async () => {
    const host = await bootstrap();
    const hostWs = await wsConnect(host.sessionToken);
    await hostWs.next();
    send(hostWs, {
      type: "pairing_code.create",
      hostId: asHostId(host.host.id),
    });
    const issued = await hostWs.next();
    if (issued.type !== "pairing_code.issued") throw new Error("unreachable");

    const clientReg = await registerClient();
    await pair(clientReg.sessionToken, issued.code);

    const clientWs = await wsConnect(clientReg.sessionToken);
    await clientWs.next();

    send(hostWs, { type: "host.announce", hostId: host.host.id });

    const clientNext = clientWs.next();
    send(hostWs, {
      type: "signal.to_client",
      toUserId: clientReg.userId as never,
      toDeviceId: clientReg.deviceId as never,
      hostId: host.host.id,
      signal: { kind: "answer", sdpBase64: "YW5zd2Vy" },
      sentAt: clockMs,
    });
    const got = await clientNext;
    expect(got.type).toBe("signal.from_host");
    if (got.type === "signal.from_host") {
      expect(got.reply.fromHostId).toBe(host.host.id);
      expect(got.reply.toDeviceId).toBe(clientReg.deviceId);
      expect(got.reply.signal.kind).toBe("answer");
    }

    await Promise.all([closeWs(hostWs), closeWs(clientWs)]);
  });

  it("returns error if non-owner tries signal.to_client", async () => {
    const host = await bootstrap();
    const attackerReg = await registerClient();
    const attackerWs = await wsConnect(attackerReg.sessionToken);
    await attackerWs.next();

    const errPromise = attackerWs.next();
    send(attackerWs, {
      type: "signal.to_client",
      toUserId: "usr_anyone" as never,
      toDeviceId: "dev_anyone" as never,
      hostId: host.host.id,
      signal: { kind: "answer", sdpBase64: "x" },
      sentAt: clockMs,
    });
    const err = await errPromise;
    expect(err.type).toBe("error");
    if (err.type === "error") {
      expect(err.code).toBe("host_access_denied");
    }

    await closeWs(attackerWs);
  });
});

describe("WS turn.credential.request", () => {
  it("issues a credential to a user with HostAccess", async () => {
    const host = await bootstrap();
    const hostWs = await wsConnect(host.sessionToken);
    await hostWs.next();

    const reqPromise = hostWs.next();
    send(hostWs, { type: "turn.credential.request", hostId: host.host.id });
    const out = await reqPromise;
    expect(out.type).toBe("turn.credential.issued");
    if (out.type === "turn.credential.issued") {
      expect(out.credential.username.endsWith(`:${host.userId}`)).toBe(true);
      expect(out.credential.password.length).toBeGreaterThan(0);
    }
    await closeWs(hostWs);
  });

  it("denies a user without HostAccess", async () => {
    const host = await bootstrap();
    const otherReg = await registerClient();
    const ws = await wsConnect(otherReg.sessionToken);
    await ws.next();
    const errP = ws.next();
    send(ws, { type: "turn.credential.request", hostId: host.host.id });
    const err = await errP;
    expect(err.type).toBe("error");
    if (err.type === "error") expect(err.code).toBe("host_access_denied");
    await closeWs(ws);
  });
});

describe("WS pairing_code.create", () => {
  it("issues a pairing code to the host owner", async () => {
    const host = await bootstrap();
    const hostWs = await wsConnect(host.sessionToken);
    await hostWs.next();
    const issuedP = hostWs.next();
    send(hostWs, {
      type: "pairing_code.create",
      hostId: asHostId(host.host.id),
    });
    const issued = await issuedP;
    expect(issued.type).toBe("pairing_code.issued");
    await closeWs(hostWs);
  });

  it("denies non-owner attempting pairing_code.create", async () => {
    const host = await bootstrap();
    const otherReg = await registerClient();
    const ws = await wsConnect(otherReg.sessionToken);
    await ws.next();
    const errP = ws.next();
    send(ws, { type: "pairing_code.create", hostId: host.host.id });
    const err = await errP;
    expect(err.type).toBe("error");
    if (err.type === "error") expect(err.code).toBe("host_access_denied");
    await closeWs(ws);
  });
});

describe("Inbound validation", () => {
  it("rejects invalid JSON with error", async () => {
    const reg = await registerClient();
    const ws = await wsConnect(reg.sessionToken);
    await ws.next();
    const errP = ws.next();
    ws.ws.send("not json");
    const err = await errP;
    expect(err.type).toBe("error");
    if (err.type === "error") expect(err.code).toBe("signal_invalid");
    await closeWs(ws);
  });

  it("rejects unknown type with error", async () => {
    const reg = await registerClient();
    const ws = await wsConnect(reg.sessionToken);
    await ws.next();
    const errP = ws.next();
    ws.ws.send(JSON.stringify({ type: "totally.fake" }));
    const err = await errP;
    expect(err.type).toBe("error");
    if (err.type === "error") expect(err.code).toBe("signal_invalid");
    await closeWs(ws);
  });
});

describe("Relay payload-blind invariant", () => {
  it("Relay does not surface SDP base64 contents in any audit entry", async () => {
    const host = await bootstrap();
    const hostWs = await wsConnect(host.sessionToken);
    await hostWs.next();
    send(hostWs, {
      type: "pairing_code.create",
      hostId: asHostId(host.host.id),
    });
    const issued = await hostWs.next();
    if (issued.type !== "pairing_code.issued") throw new Error("unreachable");

    const clientReg = await registerClient();
    await pair(clientReg.sessionToken, issued.code);
    send(hostWs, { type: "host.announce", hostId: host.host.id });

    const clientWs = await wsConnect(clientReg.sessionToken);
    await clientWs.next();

    const hostNext = hostWs.next();
    send(clientWs, {
      type: "signal.to_host",
      hostId: host.host.id,
      signal: {
        kind: "offer",
        sdpBase64: "U0VOU0lUSVZFLVNEUC1QQVlMT0FELVdT", // base64 of "SENSITIVE-SDP-PAYLOAD-WS"
      },
      sentAt: clockMs,
    });
    await hostNext;

    const auditFlat = JSON.stringify(state.auditEvents);
    expect(auditFlat).not.toContain("U0VOU0lUSVZFLVNEUC1QQVlMT0FELVdT");
    expect(auditFlat).not.toContain("SENSITIVE-SDP-PAYLOAD-WS");

    await Promise.all([closeWs(hostWs), closeWs(clientWs)]);
  });
});
