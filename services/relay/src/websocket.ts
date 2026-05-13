// Relay の WebSocket signaling layer.
//
// 接続:
// - GET /api/relay 上で HTTP upgrade. Authorization: Bearer <sessionToken>
//   を device session として認証.
// - 認証成功で WS open + `welcome` を即送信.
//
// 接続トラッキング:
// - clientConnections: Map<DeviceId, WS>  (1 device = 1 active socket)
// - hostConnections:   Map<HostId, WS>    (host.announce で hostId を bind)
//
// メッセージ dispatch:
// - inbound (Client → Relay) :
//     signal.to_host           → forwardSignal で Host へ転送 / buffer
//     turn.credential.request  → issueTurnCredential
// - inbound (Host → Relay) :
//     host.announce            → hostConnections に bind + pending buffer drain
//     signal.to_client         → client の WS へ転送
//     pairing_code.create      → createPairingCode (Host 自身が hostId 主)
//     turn.credential.request  → issueTurnCredential
//
// **broker 化はしない**: client → host も host → client も payload は
// signaling primitive (offer/answer/ice/connectionState) のみ。Relay は中身を
// 一切 decode しない. CodexLinkEvent はここを通らない.

import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

import {
  WebSocketServer,
  type WebSocket as WSConnection,
} from "ws";

import type {
  ClientToHostSignalEnvelope,
  DeviceId,
  HostId,
  HostSignalReply,
  RtcSignal,
  UserId,
} from "@codex-link/protocol/rendezvous";

import type { RelayConfig } from "./config.js";
import {
  RelayError,
  assertHostAccess,
  authenticateDeviceSession,
  createPairingCode,
} from "./relay.js";
import {
  drainBufferOnHostOnline,
  forwardSignal,
  SIGNAL_RATE_WINDOW_MS,
} from "./signaling.js";
import type { DeviceRecord, RelayState } from "./state.js";
import { issueTurnCredential, TURN_RATE_WINDOW_MS } from "./turn.js";
import type {
  WsInbound,
  WsOutbound,
} from "./ws-messages.js";

void SIGNAL_RATE_WINDOW_MS;
void TURN_RATE_WINDOW_MS;

// ===== Connection registry =====

export interface ClientConnection {
  readonly kind: "client";
  readonly device: DeviceRecord;
  readonly ws: WSConnection;
}

export interface HostConnection {
  readonly kind: "host";
  readonly device: DeviceRecord;
  readonly hostId: HostId;
  readonly ws: WSConnection;
}

export type RelayConnection = ClientConnection | HostConnection;

export interface RelayConnections {
  // device session の WS (announce 前 / client 用).
  byDevice: Map<DeviceId, WSConnection>;
  // hostId に bind した Host の WS.
  byHost: Map<HostId, HostConnection>;
}

export const createConnections = (): RelayConnections => ({
  byDevice: new Map(),
  byHost: new Map(),
});

// ===== Helpers =====

const sendOutbound = (ws: WSConnection, msg: WsOutbound): void => {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
};

const sendError = (
  ws: WSConnection,
  code: string,
  message: string,
  correlationType?: string,
): void => {
  const payload: WsOutbound = correlationType !== undefined
    ? { type: "error", code, message, correlationType }
    : { type: "error", code, message };
  sendOutbound(ws, payload);
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// ===== Parse inbound =====
//
// 受け取った text frame を WsInbound に変換 (validation 込み).

const parseInbound = (raw: string, maxBytes: number): WsInbound => {
  if (raw.length > maxBytes) {
    throw new RelayError("signal_invalid", `inbound exceeds ${maxBytes} bytes`);
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new RelayError("signal_invalid", "invalid JSON in WS frame");
  }
  if (!isPlainObject(obj)) {
    throw new RelayError("signal_invalid", "WS frame must be a JSON object");
  }
  const type = obj["type"];
  if (typeof type !== "string") {
    throw new RelayError("signal_invalid", "missing type field");
  }

  switch (type) {
    case "signal.to_host":
      return validateSignalToHost(obj);
    case "signal.to_client":
      return validateSignalToClient(obj);
    case "turn.credential.request":
      return validateTurnCredentialRequest(obj);
    case "pairing_code.create":
      return validatePairingCodeCreate(obj);
    case "host.announce":
      return validateHostAnnounce(obj);
    default:
      throw new RelayError("signal_invalid", `unknown WS type: ${type}`);
  }
};

const requireStr = (
  v: unknown,
  field: string,
  maxLen = 256,
): string => {
  if (typeof v !== "string" || v.length === 0 || v.length > maxLen) {
    throw new RelayError(
      "signal_invalid",
      `field "${field}" must be a non-empty string (<= ${maxLen})`,
    );
  }
  return v;
};

const requireNumber = (v: unknown, field: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new RelayError(
      "signal_invalid",
      `field "${field}" must be a finite number`,
    );
  }
  return v;
};

const validateSignal = (v: unknown): RtcSignal => {
  if (!isPlainObject(v)) {
    throw new RelayError("signal_invalid", "signal must be an object");
  }
  const kind = v["kind"];
  if (kind === "offer" || kind === "answer") {
    return {
      kind,
      sdpBase64: requireStr(v["sdpBase64"], "signal.sdpBase64", 64 * 1024),
    };
  }
  if (kind === "ice") {
    const sdpMid = v["sdpMid"];
    const sdpMLineIndex = v["sdpMLineIndex"];
    return {
      kind: "ice",
      candidateBase64: requireStr(
        v["candidateBase64"],
        "signal.candidateBase64",
        16 * 1024,
      ),
      sdpMid:
        sdpMid === null
          ? null
          : typeof sdpMid === "string"
            ? sdpMid
            : (() => {
                throw new RelayError("signal_invalid", "sdpMid must be string|null");
              })(),
      sdpMLineIndex:
        sdpMLineIndex === null
          ? null
          : typeof sdpMLineIndex === "number"
            ? sdpMLineIndex
            : (() => {
                throw new RelayError(
                  "signal_invalid",
                  "sdpMLineIndex must be number|null",
                );
              })(),
    };
  }
  if (kind === "connectionState") {
    const state = v["state"];
    const allowed = [
      "new",
      "checking",
      "connected",
      "completed",
      "failed",
      "disconnected",
      "closed",
    ] as const;
    if (typeof state !== "string" || !allowed.includes(state as typeof allowed[number])) {
      throw new RelayError(
        "signal_invalid",
        "connectionState.state invalid",
      );
    }
    return { kind: "connectionState", state: state as typeof allowed[number] };
  }
  throw new RelayError("signal_invalid", `unknown signal kind: ${String(kind)}`);
};

const validateSignalToHost = (
  v: Record<string, unknown>,
): WsInbound & { type: "signal.to_host" } => ({
  type: "signal.to_host",
  hostId: requireStr(v["hostId"], "hostId") as HostId,
  signal: validateSignal(v["signal"]),
  sentAt: requireNumber(v["sentAt"], "sentAt"),
});

const validateSignalToClient = (
  v: Record<string, unknown>,
): WsInbound & { type: "signal.to_client" } => ({
  type: "signal.to_client",
  toUserId: requireStr(v["toUserId"], "toUserId") as UserId,
  toDeviceId: requireStr(v["toDeviceId"], "toDeviceId") as DeviceId,
  hostId: requireStr(v["hostId"], "hostId") as HostId,
  signal: validateSignal(v["signal"]),
  sentAt: requireNumber(v["sentAt"], "sentAt"),
});

const validateTurnCredentialRequest = (
  v: Record<string, unknown>,
): WsInbound & { type: "turn.credential.request" } => ({
  type: "turn.credential.request",
  hostId: requireStr(v["hostId"], "hostId") as HostId,
});

const validatePairingCodeCreate = (
  v: Record<string, unknown>,
): WsInbound & { type: "pairing_code.create" } => ({
  type: "pairing_code.create",
  hostId: requireStr(v["hostId"], "hostId") as HostId,
});

const validateHostAnnounce = (
  v: Record<string, unknown>,
): WsInbound & { type: "host.announce" } => ({
  type: "host.announce",
  hostId: requireStr(v["hostId"], "hostId") as HostId,
});

// ===== Auth on upgrade =====

const extractBearer = (req: IncomingMessage): string | null => {
  // 1) Authorization header.
  const auth = req.headers["authorization"];
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m && m[1] !== undefined) return m[1];
  }
  // 2) Query string `?access_token=...` (Browser WS では Authorization header
  //    を送れないことがあるので fallback として認める).
  if (typeof req.url === "string") {
    const u = new URL(req.url, "http://placeholder.local");
    const qp = u.searchParams.get("access_token");
    if (qp !== null && qp.length > 0) return qp;
  }
  return null;
};

// ===== Dispatcher =====

export interface WsContext {
  readonly state: RelayState;
  readonly config: RelayConfig;
  readonly connections: RelayConnections;
  readonly now: () => number;
}

const isHostOnlineFactory =
  (ctx: WsContext) =>
  (hostId: HostId): boolean =>
    ctx.connections.byHost.has(hostId);

const deliverToHost = (
  ctx: WsContext,
  hostId: HostId,
  envelope: ClientToHostSignalEnvelope,
): boolean => {
  const conn = ctx.connections.byHost.get(hostId);
  if (conn === undefined) return false;
  sendOutbound(conn.ws, { type: "signal.from_client", envelope });
  return true;
};

const handleInbound = (
  ctx: WsContext,
  device: DeviceRecord,
  msg: WsInbound,
): void => {
  const ws = ctx.connections.byDevice.get(device.id);
  if (ws === undefined) return;

  const now = ctx.now();

  switch (msg.type) {
    case "host.announce": {
      // この WS を hostId の host connection として bind.
      const host = ctx.state.hosts.get(msg.hostId);
      if (host === undefined || host.ownerUserId !== device.userId) {
        sendError(ws, "host_not_found", `not the owner of ${msg.hostId as string}`, msg.type);
        return;
      }
      const conn: HostConnection = {
        kind: "host",
        device,
        hostId: msg.hostId,
        ws,
      };
      ctx.connections.byHost.set(msg.hostId, conn);

      // 既存 buffer を排出 (Host が unboxing する形で fan-out).
      const drained = drainBufferOnHostOnline({
        state: ctx.state,
        hostId: msg.hostId,
        now,
        ttlMs: ctx.config.pendingSignalTtlMs,
        maxAuditEvents: ctx.config.auditMaxEvents,
      });
      for (const env of drained.deliver) {
        sendOutbound(ws, { type: "signal.from_client", envelope: env });
      }
      return;
    }

    case "signal.to_host": {
      const envelope: ClientToHostSignalEnvelope = {
        fromUserId: device.userId,
        fromDeviceId: device.id,
        toHostId: msg.hostId,
        signal: msg.signal,
        sentAt: msg.sentAt,
      };
      try {
        const decision = forwardSignal({
          state: ctx.state,
          envelope,
          authenticatedUserId: device.userId,
          authenticatedDeviceId: device.id,
          isHostOnline: isHostOnlineFactory(ctx),
          ratePerMinute: ctx.config.rateLimit.signalForwardPerMinute,
          now,
          maxAuditEvents: ctx.config.auditMaxEvents,
        });
        if (decision.kind === "delivered") {
          deliverToHost(ctx, msg.hostId, envelope);
        }
        // buffered は forwardSignal 内で enqueue 済み。Host が後で announce
        // するときに drain.
      } catch (e) {
        if (e instanceof RelayError) {
          sendError(ws, e.code, e.message, msg.type);
          return;
        }
        throw e;
      }
      return;
    }

    case "signal.to_client": {
      // Host が client に reply する. Host は msg.hostId の owner であること.
      const host = ctx.state.hosts.get(msg.hostId);
      if (host === undefined || host.ownerUserId !== device.userId) {
        sendError(ws, "host_access_denied", "not the host owner", msg.type);
        return;
      }
      const targetWs = ctx.connections.byDevice.get(msg.toDeviceId);
      if (targetWs === undefined) {
        // client offline. MVP では drop (client 側で再 retry / reconnect).
        sendError(ws, "host_offline", "target client not connected", msg.type);
        return;
      }
      const reply: HostSignalReply = {
        fromHostId: msg.hostId,
        toUserId: msg.toUserId,
        toDeviceId: msg.toDeviceId,
        signal: msg.signal,
        sentAt: msg.sentAt,
      };
      sendOutbound(targetWs, { type: "signal.from_host", reply });
      return;
    }

    case "turn.credential.request": {
      try {
        const credential = issueTurnCredential({
          state: ctx.state,
          userId: device.userId,
          hostId: msg.hostId,
          now,
          turnSharedSecret: ctx.config.turnSharedSecret,
          turnUrls: ctx.config.turnUrls,
          ttlSec: ctx.config.turnCredentialTtlSec,
          ratePerMinute: ctx.config.rateLimit.turnCredentialPerMinute,
          maxAuditEvents: ctx.config.auditMaxEvents,
        });
        sendOutbound(ws, {
          type: "turn.credential.issued",
          credential,
          hostId: msg.hostId,
        });
      } catch (e) {
        if (e instanceof RelayError) {
          sendError(ws, e.code, e.message, msg.type);
          return;
        }
        throw e;
      }
      return;
    }

    case "pairing_code.create": {
      // Host owner のみ自分の hostId に対して code を作れる.
      const host = ctx.state.hosts.get(msg.hostId);
      if (host === undefined || host.ownerUserId !== device.userId) {
        sendError(ws, "host_access_denied", "not the host owner", msg.type);
        return;
      }
      try {
        const r = createPairingCode({
          state: ctx.state,
          hostId: msg.hostId,
          createdByDeviceId: device.id,
          now,
          ttlMs: ctx.config.pairingCodeTtlMs,
          maxAuditEvents: ctx.config.auditMaxEvents,
        });
        sendOutbound(ws, {
          type: "pairing_code.issued",
          code: r.code,
          expiresAt: r.record.expiresAt,
          hostId: msg.hostId,
        });
      } catch (e) {
        if (e instanceof RelayError) {
          sendError(ws, e.code, e.message, msg.type);
          return;
        }
        throw e;
      }
      return;
    }
  }
};

// ===== Attach to HTTP server =====

export interface AttachWebsocketInput {
  readonly httpServer: HttpServer;
  readonly context: WsContext;
  readonly path?: string;
}

export interface AttachedWebsocket {
  readonly wss: WebSocketServer;
  readonly close: () => Promise<void>;
}

export const attachWebsocket = ({
  httpServer,
  context,
  path = "/api/relay",
}: AttachWebsocketInput): AttachedWebsocket => {
  const wss = new WebSocketServer({ noServer: true });

  const handleUpgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const url = req.url ?? "";
    const pathOnly = url.split("?")[0] ?? "";
    if (pathOnly !== path) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const token = extractBearer(req);
    if (token === null) {
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n",
      );
      socket.destroy();
      return;
    }
    let device: DeviceRecord;
    try {
      device = authenticateDeviceSession({
        state: context.state,
        providedSessionToken: token,
        now: context.now(),
      });
    } catch {
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n",
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      onConnect(context, device, ws);
    });
  };

  httpServer.on("upgrade", handleUpgrade);

  return {
    wss,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.off("upgrade", handleUpgrade);
        wss.close((err) => (err ? reject(err) : resolve()));
      }),
  };
};

const onConnect = (
  ctx: WsContext,
  device: DeviceRecord,
  ws: WSConnection,
): void => {
  // 既に同じ deviceId の WS がいたら閉じる (1 device = 1 active socket).
  const existing = ctx.connections.byDevice.get(device.id);
  if (existing !== undefined && existing !== ws) {
    try {
      existing.close(4000, "superseded by new connection");
    } catch {
      // ignore
    }
  }
  ctx.connections.byDevice.set(device.id, ws);

  sendOutbound(ws, {
    type: "welcome",
    userId: device.userId,
    deviceId: device.id,
  });

  ws.on("message", (data) => {
    let text: string;
    if (typeof data === "string") {
      text = data;
    } else if (Buffer.isBuffer(data)) {
      text = data.toString("utf8");
    } else {
      sendError(ws, "signal_invalid", "binary frames not supported");
      return;
    }
    let parsed: WsInbound;
    try {
      parsed = parseInbound(text, ctx.config.maxWebsocketPayloadBytes);
    } catch (e) {
      if (e instanceof RelayError) {
        sendError(ws, e.code, e.message);
        return;
      }
      sendError(ws, "signal_invalid", (e as Error).message);
      return;
    }
    handleInbound(ctx, device, parsed);
  });

  ws.on("close", () => {
    if (ctx.connections.byDevice.get(device.id) === ws) {
      ctx.connections.byDevice.delete(device.id);
    }
    // host bindings を全部洗う (この device が複数 host を bind することは
    // 想定していないが、安全のため).
    for (const [hostId, conn] of ctx.connections.byHost) {
      if (conn.ws === ws) ctx.connections.byHost.delete(hostId);
    }
  });
};

// 後始末 helper: テスト用 / shutdown 用に全 connection を閉じる.
export const closeAllConnections = (connections: RelayConnections): void => {
  for (const ws of connections.byDevice.values()) {
    try {
      ws.close(1001, "shutdown");
    } catch {
      // ignore
    }
  }
  connections.byDevice.clear();
  connections.byHost.clear();
};

void assertHostAccess; // 現状 WS 層では使わず HTTP / forwardSignal 経由で済む
