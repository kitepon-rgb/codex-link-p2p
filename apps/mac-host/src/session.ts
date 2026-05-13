// SessionManager — Codex app-server と PeerManager を繋ぐ中央.
//
// 役割:
// - Codex 側 event を `CodexLinkEvent` に正規化し、connected peers へ
//   `CodexLinkSessionFrame` として broadcast する.
// - peer (iPhone) から届く `CodexLinkUIAction` を Codex app-server に
//   commands として送る.
// - peer の `SessionSnapshotRequest` に対し、現状の `CodexLinkProjection` を
//   `snapshot_response` フレームで返す (replay-on-peer).
//
// **broker 経路を一切持たない**: event は DataChannel 上でしか流れず、Relay
// にも保存されない (Host の本 SessionManager 内 state がローカル唯一の正本).

import {
  asSequenceNumber,
  type ApprovalRequest,
  type CodexLinkEvent,
  type CodexLinkProjection,
  type CodexLinkSessionFrame,
  type CodexLinkUIAction,
  type HostCapabilities,
  type ProjectDescriptor,
  type SequenceNumber,
  type SessionSnapshotResponse,
  type ThreadId,
  type ThreadProjection,
  type TimelineEntry,
  type TimelineItemCompletedEvent,
  type TimelineItemStartedEvent,
  type TranscriptItem,
  type TurnStatus,
} from "@codex-link/protocol/session";
import type { HostId, UserId, DeviceId } from "@codex-link/protocol/rendezvous";

import type {
  CodexAppServerEvent,
  CodexClient,
  CodexAppServerCommand,
} from "./codex.js";
import { normalizeCodexEvent } from "./codex-events.js";

// ===== Internal mutable thread state =====

interface ThreadState {
  threadId: ThreadId;
  title: string;
  status: TurnStatus;
  transcript: TranscriptItem[];
  timeline: TimelineEntry[];
  pendingApproval: ApprovalRequest | null;
}

// ===== Peer sink (subset of PeerManager that SessionManager touches) =====
//
// テストでは fake を渡す. 本番では `PeerManager` を直接渡せる.

export interface PeerSink {
  sendFrame(
    key: { userId: UserId; deviceId: DeviceId },
    frame: CodexLinkSessionFrame,
  ): boolean;
  broadcastFrame(frame: CodexLinkSessionFrame): number;
}

// ===== SessionManager =====

export interface SessionManagerOptions {
  readonly hostId: HostId;
  readonly hostCapabilities: HostCapabilities;
  readonly codex: CodexClient;
  readonly peers: PeerSink;
  readonly now?: () => number;
  // UI action → Codex command 変換 hook. UI action 名 / 値が Codex に
  // そのまま流れない場合に上書きする. 既定: そのまま data に詰めて type だけ
  // 規約名にする.
  readonly mapUIAction?: (
    action: CodexLinkUIAction,
  ) => CodexAppServerCommand | null;
}

const defaultMapUIAction = (
  action: CodexLinkUIAction,
): CodexAppServerCommand | null => {
  switch (action.type) {
    case "ui.submit_turn":
      return {
        type: "user_turn",
        threadId: action.threadId as string,
        data: { input: action.input },
      };
    case "ui.respond_approval":
      return {
        type: "approval_response",
        data: {
          requestId: action.decision.requestId as string,
          approved: action.decision.approved,
          ...(action.decision.reason !== undefined
            ? { reason: action.decision.reason }
            : {}),
        },
      };
    case "ui.cancel_turn":
      return {
        type: "cancel_turn",
        threadId: action.threadId as string,
      };
    case "ui.select_project":
      return {
        type: "select_project",
        data: { projectId: action.projectId },
      };
  }
};

export class SessionManager {
  private readonly options: Required<
    Omit<SessionManagerOptions, "mapUIAction">
  > & { mapUIAction: (a: CodexLinkUIAction) => CodexAppServerCommand | null };
  private readonly threads = new Map<ThreadId, ThreadState>();
  private projects: ProjectDescriptor[] = [];
  private capabilities: HostCapabilities;
  private sequenceCounter = 0;
  private unsubscribeCodex: (() => void) | null = null;

  constructor(options: SessionManagerOptions) {
    this.options = {
      hostId: options.hostId,
      hostCapabilities: options.hostCapabilities,
      codex: options.codex,
      peers: options.peers,
      now: options.now ?? (() => Date.now()),
      mapUIAction: options.mapUIAction ?? defaultMapUIAction,
    };
    this.capabilities = options.hostCapabilities;
  }

  // ===== Lifecycle =====

  start(): void {
    if (this.unsubscribeCodex !== null) return;
    this.unsubscribeCodex = this.options.codex.onEvent((e) =>
      this.handleCodexEvent(e),
    );
  }

  stop(): void {
    if (this.unsubscribeCodex !== null) {
      this.unsubscribeCodex();
      this.unsubscribeCodex = null;
    }
  }

  // ===== Inbound: peer → Host =====

  // PeerManager から来る DataChannel frame を処理する.
  handlePeerFrame(
    peer: { userId: UserId; deviceId: DeviceId },
    frame: CodexLinkSessionFrame,
  ): void {
    switch (frame.kind) {
      case "ui_action":
        void this.dispatchUIAction(frame.action);
        return;
      case "snapshot_request":
        this.sendSnapshotTo(peer);
        return;
      case "ack":
        // optional: 何もしない (将来 retransmit logic で使う).
        return;
      case "event":
      case "snapshot_response":
        // 通常は client → host でこの方向は来ない. 来ても無視する.
        return;
    }
  }

  private async dispatchUIAction(action: CodexLinkUIAction): Promise<void> {
    const cmd = this.options.mapUIAction(action);
    if (cmd === null) return;
    if (!this.options.codex.isRunning()) return;
    try {
      await this.options.codex.sendCommand(cmd);
    } catch {
      // Codex transport エラーは error.reported として broadcast する.
      this.broadcastEvent({
        type: "error.reported",
        sequence: this.nextSeq(),
        timestamp: this.options.now(),
        code: "codex_send_failed",
        message: "failed to send command to Codex app-server",
      });
    }
  }

  // ===== Outbound: Codex → peers =====

  private handleCodexEvent(raw: CodexAppServerEvent): void {
    const ev = normalizeCodexEvent(raw, {
      sequence: this.nextSeq(),
      timestamp: this.options.now(),
    });
    if (ev === null) return;
    this.applyLocalProjection(ev);
    this.broadcastEvent(ev);
  }

  private broadcastEvent(ev: CodexLinkEvent): void {
    this.options.peers.broadcastFrame({ kind: "event", event: ev });
  }

  // ===== Projection state =====

  private applyLocalProjection(ev: CodexLinkEvent): void {
    switch (ev.type) {
      case "host.capabilities.updated":
        this.capabilities = ev.capabilities;
        return;
      case "project.list.updated":
        this.projects = [...ev.projects];
        return;
      case "thread.started":
        this.threads.set(ev.threadId, {
          threadId: ev.threadId,
          title: ev.title,
          status: "idle",
          transcript: [],
          timeline: [],
          pendingApproval: null,
        });
        return;
      case "turn.status.changed": {
        const t = this.ensureThread(ev.threadId);
        t.status = ev.status;
        return;
      }
      case "assistant.delta":
        // 中間状態は projection には積まない (final で正規化される). 必要なら
        // 後続でストリーミング textbuf を持つ.
        return;
      case "assistant.final": {
        const t = this.ensureThread(ev.threadId);
        t.transcript.push({
          id: `a_${ev.sequence as number}`,
          role: "assistant",
          content: ev.text,
        });
        return;
      }
      case "transcript.item.recorded": {
        const t = this.ensureThread(ev.threadId);
        t.transcript.push(ev.item);
        return;
      }
      case "timeline.item.started":
        this.addTimelineStart(ev);
        return;
      case "timeline.item.completed":
        this.completeTimeline(ev);
        return;
      case "approval.requested": {
        const t = this.ensureThread(ev.request.threadId);
        t.pendingApproval = ev.request;
        return;
      }
      case "approval.resolved": {
        const t = this.ensureThread(ev.threadId);
        t.pendingApproval = null;
        return;
      }
      case "rate_limit.updated":
      case "error.reported":
        return;
    }
  }

  private addTimelineStart(ev: TimelineItemStartedEvent): void {
    const t = this.ensureThread(ev.threadId);
    t.timeline.push({
      itemId: ev.itemId,
      kind: ev.kind,
      label: ev.label,
      outcome: null,
    });
  }

  private completeTimeline(ev: TimelineItemCompletedEvent): void {
    const t = this.ensureThread(ev.threadId);
    const idx = t.timeline.findIndex((x) => x.itemId === ev.itemId);
    if (idx < 0) return;
    const existing = t.timeline[idx];
    if (existing === undefined) return;
    t.timeline[idx] = {
      itemId: existing.itemId,
      kind: existing.kind,
      label: existing.label,
      outcome: ev.outcome,
    };
  }

  private ensureThread(threadId: ThreadId): ThreadState {
    let t = this.threads.get(threadId);
    if (t === undefined) {
      t = {
        threadId,
        title: "Untitled",
        status: "idle",
        transcript: [],
        timeline: [],
        pendingApproval: null,
      };
      this.threads.set(threadId, t);
    }
    return t;
  }

  // ===== Snapshot =====

  buildProjection(): CodexLinkProjection {
    const threads: ThreadProjection[] = [...this.threads.values()].map((t) => ({
      threadId: t.threadId,
      title: t.title,
      status: t.status,
      transcript: [...t.transcript],
      timeline: [...t.timeline],
      pendingApproval: t.pendingApproval,
    }));
    return {
      hostId: this.options.hostId,
      capabilities: this.capabilities,
      projects: [...this.projects],
      threads,
      latestSequence: asSequenceNumber(this.sequenceCounter),
      capturedAt: this.options.now(),
    };
  }

  private sendSnapshotTo(peer: {
    userId: UserId;
    deviceId: DeviceId;
  }): void {
    const response: SessionSnapshotResponse = {
      projection: this.buildProjection(),
    };
    this.options.peers.sendFrame(peer, {
      kind: "snapshot_response",
      response,
    });
  }

  private nextSeq(): SequenceNumber {
    this.sequenceCounter += 1;
    return asSequenceNumber(this.sequenceCounter);
  }

  // ===== Inspection (tests) =====

  currentProjection(): CodexLinkProjection {
    return this.buildProjection();
  }

  currentSequence(): number {
    return this.sequenceCounter;
  }
}
