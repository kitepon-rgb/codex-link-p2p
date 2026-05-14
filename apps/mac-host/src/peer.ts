// iPhone client ごとの WebRTC PeerConnection (answerer 固定).
//
// 役割:
// - Relay 経由で届く offer SDP / ICE candidate を node-datachannel に
//   渡し、自動生成された answer SDP / ローカル候補を Relay 経由で client に
//   返す.
// - DataChannel "codex-link-session" (reliable / ordered) を経由して
//   CodexLinkSessionFrame を双方向に流す.
// - 接続経路 (host / srflx / relay) の selected candidate pair を 5s 周期で
//   取得し、UI に報告する (Phase 7 で利用; ここではメトリクス API を提供).
// - peer 切断時の自動 cleanup.
//
// 注意:
// - **DataChannel 上は session protocol 専用** (CodexLinkSessionFrame). 受領
//   メッセージは text JSON として parse して frame に decode する.
// - Relay は payload を見ない (本クライアントは Relay に SDP / candidate を
//   base64 で送る. Relay の payload-blind 性は signaling-client 側の責務).

import {
  PeerConnection,
  type DataChannel,
} from "node-datachannel";

import type {
  DeviceId,
  HostId,
  HostSignalReply,
  RtcConnectionState,
  RtcSignal,
  UserId,
} from "@codex-link/protocol/rendezvous";
import type {
  CodexLinkSessionFrame,
} from "@codex-link/protocol/session";

// ===== Configuration / types =====

export const DATA_CHANNEL_LABEL = "codex-link-session";

export interface PeerConfig {
  readonly hostId: HostId;
  readonly iceServers: readonly string[]; // stun: / turn: / turns: URLs
  // state=failed が継続したら自動 close する閾値. 既定 10s.
  readonly failedCleanupMs?: number;
  // 時刻ソース (テストで差し替え可能).
  readonly clock?: () => number;
}

export interface PeerKey {
  readonly userId: UserId;
  readonly deviceId: DeviceId;
}

const peerKey = (k: PeerKey): string =>
  `${k.userId as string}:${k.deviceId as string}`;

export interface PeerStats {
  readonly state: RtcConnectionState;
  readonly iceState: string;
  readonly bytesSent: number;
  readonly bytesReceived: number;
  readonly rttMs: number | null;
  readonly selectedCandidateLocal: string | null;
  readonly selectedCandidateRemote: string | null;
}

export type ConnectionPath =
  | "connecting"
  | "direct"
  | "stunReflexive"
  | "turnRelayed"
  | "failed";

export interface PeerHandlers {
  // signaling 経由で外部 (Relay) に渡す.
  readonly onLocalSignal: (
    peer: PeerKey,
    signal: HostSignalReply,
  ) => void;
  // DataChannel が open になった通知.
  readonly onDataChannelOpen?: (peer: PeerKey) => void;
  // DataChannel に到着した frame.
  readonly onFrame?: (peer: PeerKey, frame: CodexLinkSessionFrame) => void;
  // Peer 状態変化.
  readonly onStateChange?: (peer: PeerKey, state: RtcConnectionState) => void;
  // 接続経路の更新 (selected candidate pair から導出).
  readonly onConnectionPathChange?: (peer: PeerKey, path: ConnectionPath) => void;
  // 内部ログ.
  readonly onLog?: (
    level: "debug" | "info" | "warn" | "error",
    msg: string,
    extra?: Record<string, unknown>,
  ) => void;
}

// 内部 1 peer.
interface PeerEntry {
  readonly key: PeerKey;
  readonly pc: PeerConnection;
  dc: DataChannel | null;
  state: RtcConnectionState;
  connectionPath: ConnectionPath;
  // state が 'failed' に入った時刻. failed 以外に戻ったら null に戻す.
  failedSince: number | null;
}

// ===== PeerManager =====

export class PeerManager {
  private readonly peers = new Map<string, PeerEntry>();
  private readonly handlers: PeerHandlers;
  private readonly config: PeerConfig;
  private readonly failedCleanupMs: number;
  private readonly clock: () => number;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  // ICE candidate を base64 で envelope に詰めるが、node-datachannel の
  // addRemoteCandidate は plain text candidate を期待する. なので
  // candidateBase64 を decode してから渡す.

  constructor(config: PeerConfig, handlers: PeerHandlers) {
    this.config = config;
    this.handlers = handlers;
    this.failedCleanupMs = config.failedCleanupMs ?? 10_000;
    this.clock = config.clock ?? (() => Date.now());
  }

  startStatsLoop(intervalMs = 5_000): void {
    if (this.statsTimer !== null) return;
    this.statsTimer = setInterval(() => {
      for (const entry of [...this.peers.values()]) {
        this.refreshConnectionPath(entry);
      }
      this.pruneFailedPeers();
    }, intervalMs);
  }

  stopStatsLoop(): void {
    if (this.statsTimer !== null) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  // ===== Inbound signaling =====

  // signal.from_client (Relay → Host) を peer に取り込む.
  applyClientSignal(
    key: PeerKey,
    signal: RtcSignal,
    iceServersOverride?: readonly string[],
  ): void {
    switch (signal.kind) {
      case "offer": {
        // 新規 peer の場合に作る.
        const entry = this.ensurePeer(key, iceServersOverride);
        const sdp = Buffer.from(signal.sdpBase64, "base64").toString("utf8");
        try {
          entry.pc.setRemoteDescription(sdp, "offer");
        } catch (e) {
          this.handlers.onLog?.("warn", "setRemoteDescription_offer_failed", {
            error: (e as Error).message,
            peer: peerKey(key),
          });
        }
        return;
      }
      case "answer": {
        // Host は answerer 固定 (offerer になるケースは MVP では無いが、
        // protocol 上は受けられる).
        const entry = this.peers.get(peerKey(key));
        if (entry === undefined) {
          this.handlers.onLog?.("warn", "answer_received_for_unknown_peer", {
            peer: peerKey(key),
          });
          return;
        }
        const sdp = Buffer.from(signal.sdpBase64, "base64").toString("utf8");
        try {
          entry.pc.setRemoteDescription(sdp, "answer");
        } catch (e) {
          this.handlers.onLog?.("warn", "setRemoteDescription_answer_failed", {
            error: (e as Error).message,
            peer: peerKey(key),
          });
        }
        return;
      }
      case "ice": {
        const entry = this.peers.get(peerKey(key));
        if (entry === undefined) {
          this.handlers.onLog?.("warn", "ice_candidate_for_unknown_peer", {
            peer: peerKey(key),
          });
          return;
        }
        const candidate = Buffer.from(
          signal.candidateBase64,
          "base64",
        ).toString("utf8");
        try {
          entry.pc.addRemoteCandidate(candidate, signal.sdpMid ?? "0");
        } catch (e) {
          this.handlers.onLog?.("warn", "addRemoteCandidate_failed", {
            error: (e as Error).message,
            peer: peerKey(key),
          });
        }
        return;
      }
      case "connectionState":
        // client → host の状態通知. UI 用ヒント. ここでは無視 (peer 自身の
        // state を使う方が信頼できる).
        return;
    }
  }

  // ===== Outbound (DataChannel send) =====

  sendFrame(key: PeerKey, frame: CodexLinkSessionFrame): boolean {
    const entry = this.peers.get(peerKey(key));
    if (entry === undefined || entry.dc === null) return false;
    if (entry.dc.isOpen?.() !== true) return false;
    try {
      entry.dc.sendMessage(JSON.stringify(frame));
      return true;
    } catch (e) {
      this.handlers.onLog?.("warn", "datachannel_send_failed", {
        error: (e as Error).message,
        peer: peerKey(key),
      });
      return false;
    }
  }

  broadcastFrame(frame: CodexLinkSessionFrame): number {
    let count = 0;
    for (const entry of this.peers.values()) {
      if (this.sendFrame(entry.key, frame)) count += 1;
    }
    return count;
  }

  // ===== Lifecycle =====

  closePeer(key: PeerKey): void {
    const id = peerKey(key);
    const entry = this.peers.get(id);
    if (entry === undefined) return;
    try {
      entry.dc?.close();
    } catch {
      // ignore
    }
    try {
      entry.pc.close();
    } catch {
      // ignore
    }
    this.peers.delete(id);
  }

  closeAll(): void {
    for (const entry of [...this.peers.values()]) {
      this.closePeer(entry.key);
    }
    this.stopStatsLoop();
  }

  // 全 peer を close する. closeAll と違って stats loop は止めない.
  // 用途: signaling の再 welcome を受けた時の「前回 WS で確立した peer は
  // 相手側 (Relay / iPhone) から見て stale なので一旦全消去」.
  dropAllPeers(): readonly PeerKey[] {
    const dropped: PeerKey[] = [];
    for (const entry of [...this.peers.values()]) {
      dropped.push(entry.key);
      this.closePeer(entry.key);
    }
    if (dropped.length > 0) {
      this.handlers.onLog?.("info", "peer_drop_all", { count: dropped.length });
    }
    return dropped;
  }

  // state=failed が failedCleanupMs を超えて継続した peer を close + 削除する.
  // 戻り値は実際に削除した peer の key.
  pruneFailedPeers(): readonly PeerKey[] {
    const removed: PeerKey[] = [];
    const now = this.clock();
    for (const entry of [...this.peers.values()]) {
      if (
        entry.failedSince !== null &&
        now - entry.failedSince >= this.failedCleanupMs
      ) {
        const elapsedMs = now - entry.failedSince;
        this.handlers.onLog?.("info", "peer_cleanup_failed_stale", {
          peer: peerKey(entry.key),
          elapsedMs,
        });
        this.closePeer(entry.key);
        removed.push(entry.key);
      }
    }
    return removed;
  }

  hasPeer(key: PeerKey): boolean {
    return this.peers.has(peerKey(key));
  }

  peerCount(): number {
    return this.peers.size;
  }

  stats(key: PeerKey): PeerStats | null {
    const entry = this.peers.get(peerKey(key));
    if (entry === undefined) return null;
    const selected = entry.pc.getSelectedCandidatePair?.();
    return {
      state: entry.state,
      iceState: entry.pc.iceState?.() ?? "unknown",
      bytesSent: entry.pc.bytesSent?.() ?? 0,
      bytesReceived: entry.pc.bytesReceived?.() ?? 0,
      rttMs: entry.pc.rtt?.() ?? null,
      selectedCandidateLocal: selected?.local?.candidate ?? null,
      selectedCandidateRemote: selected?.remote?.candidate ?? null,
    };
  }

  connectionPath(key: PeerKey): ConnectionPath | null {
    const entry = this.peers.get(peerKey(key));
    return entry?.connectionPath ?? null;
  }

  // ===== Internal =====

  private ensurePeer(
    key: PeerKey,
    iceServersOverride?: readonly string[],
  ): PeerEntry {
    const id = peerKey(key);
    const existing = this.peers.get(id);
    if (existing !== undefined) return existing;

    const iceServers = iceServersOverride ?? this.config.iceServers;
    const pc = new PeerConnection(id, {
      iceServers: [...iceServers],
    });

    const entry: PeerEntry = {
      key,
      pc,
      dc: null,
      state: "new",
      connectionPath: "connecting",
      failedSince: null,
    };
    this.peers.set(id, entry);

    pc.onLocalDescription((sdp: string, type: string) => {
      // answerer なので type は通常 "answer".
      const sdpBase64 = Buffer.from(sdp, "utf8").toString("base64");
      if (type === "answer" || type === "offer") {
        const reply: HostSignalReply = {
          fromHostId: this.config.hostId,
          toUserId: key.userId,
          toDeviceId: key.deviceId,
          signal: { kind: type, sdpBase64 },
          sentAt: Date.now(),
        };
        this.handlers.onLocalSignal(key, reply);
      }
    });

    pc.onLocalCandidate((candidate: string, mid: string) => {
      const reply: HostSignalReply = {
        fromHostId: this.config.hostId,
        toUserId: key.userId,
        toDeviceId: key.deviceId,
        signal: {
          kind: "ice",
          candidateBase64: Buffer.from(candidate, "utf8").toString("base64"),
          sdpMid: mid,
          sdpMLineIndex: null,
        },
        sentAt: Date.now(),
      };
      this.handlers.onLocalSignal(key, reply);
    });

    pc.onStateChange((state: string) => {
      const mapped = mapState(state);
      entry.state = mapped;
      this.handlers.onStateChange?.(key, mapped);
      this.refreshConnectionPath(entry);
    });

    pc.onIceStateChange(() => {
      this.refreshConnectionPath(entry);
    });

    pc.onDataChannel((dc: DataChannel) => {
      entry.dc = dc;
      dc.onOpen(() => {
        this.handlers.onDataChannelOpen?.(key);
      });
      dc.onMessage((msg: string | ArrayBuffer | Buffer) => {
        let text: string;
        if (typeof msg === "string") {
          text = msg;
        } else if (Buffer.isBuffer(msg)) {
          text = msg.toString("utf8");
        } else {
          text = Buffer.from(msg).toString("utf8");
        }
        let frame: CodexLinkSessionFrame;
        try {
          frame = JSON.parse(text) as CodexLinkSessionFrame;
        } catch {
          this.handlers.onLog?.("warn", "datachannel_message_invalid_json");
          return;
        }
        this.handlers.onFrame?.(key, frame);
      });
      dc.onClosed(() => {
        if (entry.dc === dc) entry.dc = null;
      });
    });

    return entry;
  }

  private refreshConnectionPath(entry: PeerEntry): void {
    // failed 状態の入り口/出口を failedSince に反映 (cleanup タイマ用).
    if (entry.state === "failed") {
      if (entry.failedSince === null) {
        entry.failedSince = this.clock();
      }
    } else if (entry.failedSince !== null) {
      entry.failedSince = null;
    }

    const selected = entry.pc.getSelectedCandidatePair?.();
    let path: ConnectionPath = "connecting";
    if (entry.state === "failed") {
      path = "failed";
    } else if (selected !== undefined && selected !== null) {
      const localType = selected.local?.type ?? "";
      const remoteType = selected.remote?.type ?? "";
      if (localType === "relay" || remoteType === "relay") {
        path = "turnRelayed";
      } else if (localType === "srflx" || remoteType === "srflx") {
        path = "stunReflexive";
      } else if (localType === "host" && remoteType === "host") {
        path = "direct";
      } else if (entry.state === "connected") {
        path = "direct";
      }
    }
    if (path !== entry.connectionPath) {
      entry.connectionPath = path;
      this.handlers.onConnectionPathChange?.(entry.key, path);
    }
  }
}

// node-datachannel の state 文字列を rendezvous の RtcConnectionState に map.
const mapState = (s: string): RtcConnectionState => {
  switch (s) {
    case "new":
      return "new";
    case "connecting":
      return "checking";
    case "connected":
      return "connected";
    case "disconnected":
      return "disconnected";
    case "failed":
      return "failed";
    case "closed":
      return "closed";
    default:
      return "new";
  }
};
