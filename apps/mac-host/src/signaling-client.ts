// Mac Host から Relay への signaling WebSocket client.
//
// 役割:
// - WSS 接続 + Bearer 認証 + welcome 受領
// - host.announce で hostId を Relay に bind
// - 受信: signal.from_client / turn.credential.issued / pairing_code.issued /
//   error
// - 送信: signal.to_client (peer 反対方向) / turn.credential.request /
//   pairing_code.create
// - 自動再接続 (指数バックオフ + jitter)
//
// **`sendHostEvent` / `host.event` 等の broker 経路は作らない**. このクライアント
// は signaling envelope と TURN credential / pairing code 発行だけを扱う.

import WS from "ws";

import type {
  DeviceId,
  HostId,
  HostSignalReply,
  OutboundPairingCodeIssued,
  OutboundSignalFromClient,
  OutboundTurnCredentialIssued,
  RtcSignal,
  UserId,
  WsInbound,
  WsOutbound,
} from "@codex-link/protocol/rendezvous";

import { wsRelayUrl } from "./config.js";

// ===== Public types =====

export type SignalingClientState =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

export interface SignalingClientHandlers {
  readonly onWelcome?: (info: { userId: UserId; deviceId: DeviceId }) => void;
  readonly onSignalFromClient?: (
    msg: OutboundSignalFromClient,
  ) => void | Promise<void>;
  readonly onTurnCredential?: (
    msg: OutboundTurnCredentialIssued,
  ) => void | Promise<void>;
  readonly onPairingCodeIssued?: (
    msg: OutboundPairingCodeIssued,
  ) => void | Promise<void>;
  readonly onError?: (msg: {
    readonly code: string;
    readonly message: string;
    readonly correlationType?: string;
  }) => void;
  readonly onStateChange?: (s: SignalingClientState) => void;
  // 構造化ログ. info 程度は省略可能.
  readonly onLog?: (
    level: "debug" | "info" | "warn" | "error",
    msg: string,
    extra?: Record<string, unknown>,
  ) => void;
}

export interface SignalingClientOptions {
  readonly relayUrl: string; // https?://...
  readonly sessionToken: string;
  readonly handlers: SignalingClientHandlers;
  // 再接続バックオフ: ms 単位、min から max まで指数 + jitter.
  readonly reconnectMinMs?: number;
  readonly reconnectMaxMs?: number;
  // テスト注入用 (default は global ws).
  readonly wsConstructor?: typeof WS;
  // テスト注入用 (default は setTimeout).
  readonly setTimeoutFn?: typeof setTimeout;
}

// ===== Implementation =====

export class SignalingClient {
  private ws: WS | null = null;
  private state: SignalingClientState = "idle";
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  private readonly options: Required<
    Omit<SignalingClientOptions, "handlers">
  > & { handlers: SignalingClientHandlers };

  constructor(options: SignalingClientOptions) {
    this.options = {
      handlers: options.handlers,
      relayUrl: options.relayUrl,
      sessionToken: options.sessionToken,
      reconnectMinMs: options.reconnectMinMs ?? 500,
      reconnectMaxMs: options.reconnectMaxMs ?? 15_000,
      wsConstructor: options.wsConstructor ?? WS,
      setTimeoutFn: options.setTimeoutFn ?? setTimeout,
    };
  }

  // ----- lifecycle -----

  start(): void {
    if (this.state !== "idle" && this.state !== "closed") return;
    this.intentionallyClosed = false;
    this.connect();
  }

  close(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws !== null) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.setState("closed");
  }

  // ----- outbound senders -----

  announce(hostId: HostId): void {
    this.send({ type: "host.announce", hostId });
  }

  sendSignalToClient(reply: HostSignalReply): void {
    this.send({
      type: "signal.to_client",
      toUserId: reply.toUserId,
      toDeviceId: reply.toDeviceId,
      hostId: reply.fromHostId,
      signal: reply.signal,
      sentAt: reply.sentAt,
    });
  }

  // 通常 Host は client からの offer 等を待つ. テスト目的等で host 側から
  // signal.to_host を打ちたいケースは想定していないが、protocol 上は両方向
  // 可能なので一応 helper を用意.
  sendSignalToHost(hostId: HostId, signal: RtcSignal, sentAt: number): void {
    this.send({ type: "signal.to_host", hostId, signal, sentAt });
  }

  requestTurnCredential(hostId: HostId): void {
    this.send({ type: "turn.credential.request", hostId });
  }

  createPairingCode(hostId: HostId): void {
    this.send({ type: "pairing_code.create", hostId });
  }

  // 低レベル API: 検査済み inbound を直接送る.
  send(msg: WsInbound): void {
    if (this.ws === null || this.ws.readyState !== WS.OPEN) {
      this.log("warn", "send_dropped_socket_not_open", { type: msg.type });
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  currentState(): SignalingClientState {
    return this.state;
  }

  // ----- internals -----

  private connect(): void {
    this.setState(this.reconnectAttempts === 0 ? "connecting" : "reconnecting");
    const url = wsRelayUrl(this.options.relayUrl) + "/api/relay";

    let ws: WS;
    try {
      ws = new this.options.wsConstructor(url, {
        headers: { authorization: `Bearer ${this.options.sessionToken}` },
      });
    } catch (e) {
      this.log("error", "ws_construct_failed", { error: (e as Error).message });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.setState("open");
      this.log("info", "ws_open", { url });
    });

    ws.on("message", (raw) => {
      let text: string;
      if (typeof raw === "string") text = raw;
      else if (Buffer.isBuffer(raw)) text = raw.toString("utf8");
      else {
        this.log("warn", "ws_message_binary_unsupported");
        return;
      }
      let parsed: WsOutbound;
      try {
        parsed = JSON.parse(text) as WsOutbound;
      } catch {
        this.log("warn", "ws_message_parse_failed", { text });
        return;
      }
      this.dispatchOutbound(parsed);
    });

    ws.on("error", (err) => {
      this.log("warn", "ws_error", { error: err.message });
    });

    ws.on("close", (code, reason) => {
      const reasonStr =
        typeof reason === "string" ? reason : reason.toString("utf8");
      this.log("info", "ws_close", { code, reason: reasonStr });
      this.ws = null;
      if (this.intentionallyClosed) {
        this.setState("closed");
        return;
      }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts += 1;
    const base =
      this.options.reconnectMinMs * 2 ** Math.min(this.reconnectAttempts - 1, 8);
    const capped = Math.min(base, this.options.reconnectMaxMs);
    const jitter = Math.floor(Math.random() * Math.min(capped, 500));
    const wait = capped + jitter;
    this.log("info", "ws_reconnect_scheduled", {
      attempt: this.reconnectAttempts,
      waitMs: wait,
    });
    this.setState("reconnecting");
    this.reconnectTimer = this.options.setTimeoutFn(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
  }

  private dispatchOutbound(msg: WsOutbound): void {
    switch (msg.type) {
      case "welcome":
        this.options.handlers.onWelcome?.({
          userId: msg.userId,
          deviceId: msg.deviceId,
        });
        return;
      case "signal.from_client":
        void this.options.handlers.onSignalFromClient?.(msg);
        return;
      case "signal.from_host":
        // Host 側でこの message が来ることは通常ない (これは client 側 helper
        // が受け取るもの). 念のため log のみ.
        this.log("warn", "signal_from_host_unexpected_on_host");
        return;
      case "turn.credential.issued":
        void this.options.handlers.onTurnCredential?.(msg);
        return;
      case "pairing_code.issued":
        void this.options.handlers.onPairingCodeIssued?.(msg);
        return;
      case "error":
        this.options.handlers.onError?.({
          code: msg.code,
          message: msg.message,
          ...(msg.correlationType !== undefined
            ? { correlationType: msg.correlationType }
            : {}),
        });
        return;
    }
  }

  private setState(s: SignalingClientState): void {
    if (this.state === s) return;
    this.state = s;
    this.options.handlers.onStateChange?.(s);
  }

  private log(
    level: "debug" | "info" | "warn" | "error",
    msg: string,
    extra?: Record<string, unknown>,
  ): void {
    this.options.handlers.onLog?.(level, msg, extra);
  }
}
