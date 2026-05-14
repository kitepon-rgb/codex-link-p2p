// SessionManager — Codex app-server と PeerManager を繋ぐ中央.
//
// 役割:
// - Codex の JSON-RPC notification を `CodexLinkEvent` に正規化し、
//   connected peers へ `SessionFrameEvent` として broadcast する.
// - Codex の server request (approval 等) を peer に届ける. peer の
//   `ui.respond_approval` を受けたら Codex に response を返す.
// - peer (iPhone) から届く `CodexLinkUIAction` を Codex JSON-RPC に dispatch.
// - peer の `SessionSnapshotRequest` に対し、現状の `CodexLinkProjection` を
//   `snapshot_response` で返す (replay-on-peer).
//
// **broker 経路を一切持たない**: event は DataChannel 上でしか流れず、Relay
// にも保存されない. ここに溜まる state がローカル唯一の正本.

import {
  asProjectId,
  asRequestId,
  asSequenceNumber,
  asThreadId,
  asTurnId,
  type ApprovalDecisionKind,
  type CodexLinkEvent,
  type CodexLinkProjection,
  type CodexLinkSessionFrame,
  type CodexLinkUIAction,
  type HostCapabilities,
  type HostChatGptAccount,
  type ItemId,
  type ProjectId,
  type ProjectRef,
  type RequestId,
  type SequenceNumber,
  type SessionSnapshotResponse,
  type ThreadProjection,
  type ThreadRef,
  type TimelineEntry,
  type TimelineItemCompletedEvent,
  type TimelineItemStartedEvent,
  type TranscriptItem,
  type TurnId,
  type ThreadId,
  type TurnStatus,
} from "@codex-link/protocol/session";
import type { HostId, UserId, DeviceId } from "@codex-link/protocol/rendezvous";
import type {
  CodexAppServerClient,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcServerRequest,
} from "@codex-link/codex-client";

import {
  codexNotificationToEvents,
  codexServerRequestToEvent,
} from "./codex-events.js";

// ===== Internal mutable thread state =====

interface ThreadState {
  thread: ThreadRef;
  status: TurnStatus;
  currentTurnId: TurnId | null;
  transcript: TranscriptItem[];
  timeline: TimelineEntry[];
  pendingApproval: import("@codex-link/protocol/session").ApprovalRequest | null;
  streamingAssistant: string;
}

// ===== Peer sink =====

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
  readonly codex: CodexAppServerClient;
  readonly peers: PeerSink;
  readonly now?: () => number;
  readonly defaultProjectId: ProjectId;
}

export class SessionManager {
  private readonly options: Required<Omit<SessionManagerOptions, "defaultProjectId">> & {
    readonly defaultProjectId: ProjectId;
  };
  private readonly threads = new Map<ThreadId, ThreadState>();
  private projects: ProjectRef[] = [];
  private capabilities: HostCapabilities;
  private account: HostChatGptAccount | null = null;
  private sequenceCounter = 0;
  /// approval.requested の RequestId と、Codex から来た server request の id の対応.
  /// iPhone が ui.respond_approval を返した時、対応する server request id に対して
  /// codex.respondToServerRequest を呼ぶ.
  private readonly pendingApprovals = new Map<RequestId, JsonRpcId>();

  constructor(options: SessionManagerOptions) {
    this.options = {
      hostId: options.hostId,
      hostCapabilities: options.hostCapabilities,
      codex: options.codex,
      peers: options.peers,
      now: options.now ?? (() => Date.now()),
      defaultProjectId: options.defaultProjectId,
    };
    this.capabilities = options.hostCapabilities;
  }

  // ===== Codex side =====

  handleCodexNotification(message: JsonRpcNotification): void {
    const events = codexNotificationToEvents(message, this.options.defaultProjectId);
    for (const ev of events) {
      this.processOutboundEvent(ev);
    }
  }

  handleCodexServerRequest(message: JsonRpcServerRequest): void {
    const event = codexServerRequestToEvent(message, {
      activeTurnIdForThread: (threadId) => {
        const t = this.threads.get(threadId as ThreadId);
        return t?.currentTurnId === null ? undefined : (t?.currentTurnId as string | undefined);
      },
    });
    if (event === null) {
      return;
    }
    if (event.type === "approval.requested") {
      this.pendingApprovals.set(event.request.id, message.id);
    }
    this.processOutboundEvent(event);
  }

  // ===== Peer side =====

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
        // 将来 retransmit logic で使う. 今は no-op.
        return;
      case "event":
      case "snapshot_response":
        // 通常 client → host でこの方向は来ない. 来ても無視.
        return;
    }
  }

  private async dispatchUIAction(action: CodexLinkUIAction): Promise<void> {
    try {
      switch (action.type) {
        case "ui.submit_turn":
          if (action.threadId !== null) {
            await this.options.codex.startTurn({
              threadId: action.threadId as string,
              prompt: action.input,
            });
          } else {
            await this.options.codex.startThread({
              projectId: action.projectId as string,
              prompt: action.input,
            });
          }
          return;
        case "ui.respond_approval": {
          const serverRequestId = this.pendingApprovals.get(action.decision.requestId);
          if (serverRequestId !== undefined) {
            this.options.codex.respondToServerRequest(serverRequestId, {
              decision: decisionToCodex(action.decision.decision),
            });
            this.pendingApprovals.delete(action.decision.requestId);
          }
          // Also broadcast approval.resolved so projection is updated.
          this.processOutboundEvent({
            type: "approval.resolved",
            requestId: action.decision.requestId,
            decision: action.decision.decision,
          });
          return;
        }
        case "ui.cancel_turn":
          await this.options.codex.interruptTurn({
            threadId: action.threadId as string,
            turnId: action.turnId as string,
          });
          return;
        case "ui.select_project":
          // Project 切替は state を変えるだけ. UI 側で thread list 表示更新.
          // 現状は no-op (将来 multi-project 対応で listThreads する).
          return;
        case "ui.resume_thread":
          await this.options.codex.resumeThread({
            threadId: action.threadId as string,
          });
          return;
      }
    } catch (e) {
      this.processOutboundEvent({
        type: "error.reported",
        scope: "codex",
        message: `dispatchUIAction failed: ${(e as Error).message}`,
      });
    }
  }

  // ===== Outbound: stamp + apply local + broadcast =====

  private processOutboundEvent(event: CodexLinkEvent): void {
    this.applyLocalProjection(event);
    const sequence = this.nextSeq();
    const timestamp = this.options.now();
    this.options.peers.broadcastFrame({
      kind: "event",
      sequence,
      timestamp,
      event,
    });
  }

  // ===== Projection state =====

  private applyLocalProjection(ev: CodexLinkEvent): void {
    switch (ev.type) {
      case "host.account.updated":
        this.account = ev.account;
        return;
      case "host.capabilities.updated":
        this.capabilities = ev.capabilities;
        return;
      case "project.list.updated":
        this.projects = [...ev.projects];
        return;
      case "thread.started":
        this.ensureThread(ev.thread);
        return;
      case "turn.status.changed": {
        const t = this.ensureThreadById(ev.threadId);
        t.status = ev.status;
        t.currentTurnId = ev.status === "running" ? ev.turnId : null;
        if (ev.status === "completed" || ev.status === "failed" || ev.status === "canceled") {
          // Streaming buffer flush: clear streamingAssistant on turn end.
          t.streamingAssistant = "";
        }
        return;
      }
      case "assistant.delta": {
        const t = this.ensureThreadById(ev.threadId);
        t.streamingAssistant += ev.text;
        return;
      }
      case "assistant.final": {
        const t = this.ensureThreadById(ev.threadId);
        t.streamingAssistant = "";
        t.transcript.push({ id: ev.itemId, role: "assistant", text: ev.text });
        return;
      }
      case "transcript.item.recorded": {
        const t = this.ensureThreadById(ev.threadId);
        t.transcript.push({ id: ev.itemId, role: ev.role, text: ev.text });
        return;
      }
      case "timeline.item.started":
        this.addTimelineStart(ev);
        return;
      case "timeline.item.completed":
        this.completeTimeline(ev);
        return;
      case "approval.requested": {
        const t = this.ensureThreadById(ev.request.threadId);
        t.pendingApproval = ev.request;
        return;
      }
      case "approval.resolved": {
        for (const t of this.threads.values()) {
          if (t.pendingApproval?.id === ev.requestId) {
            t.pendingApproval = null;
          }
        }
        return;
      }
      case "rate_limit.updated":
      case "diagnostic.reported":
      case "error.reported":
        return;
    }
  }

  private addTimelineStart(ev: TimelineItemStartedEvent): void {
    const t = this.ensureThreadById(ev.threadId);
    t.timeline.push({
      itemId: ev.itemId,
      turnId: ev.turnId,
      label: ev.label,
      detail: ev.detail ?? null,
      status: "running",
    });
  }

  private completeTimeline(ev: TimelineItemCompletedEvent): void {
    const t = this.ensureThreadById(ev.threadId);
    const idx = t.timeline.findIndex((x) => x.itemId === ev.itemId);
    if (idx < 0) return;
    const existing = t.timeline[idx];
    if (existing === undefined) return;
    t.timeline[idx] = {
      itemId: existing.itemId,
      turnId: existing.turnId,
      label: existing.label,
      detail: existing.detail,
      status: ev.status,
    };
  }

  private ensureThread(thread: ThreadRef): ThreadState {
    const existing = this.threads.get(thread.id);
    if (existing !== undefined) {
      // Preserve transcript; just update ref.
      existing.thread = thread;
      return existing;
    }
    const t: ThreadState = {
      thread,
      status: "idle",
      currentTurnId: null,
      transcript: [],
      timeline: [],
      pendingApproval: null,
      streamingAssistant: "",
    };
    this.threads.set(thread.id, t);
    return t;
  }

  private ensureThreadById(threadId: ThreadId): ThreadState {
    const existing = this.threads.get(threadId);
    if (existing !== undefined) return existing;
    return this.ensureThread({
      id: threadId,
      projectId: this.options.defaultProjectId,
      title: null,
      updatedAt: null,
    });
  }

  // ===== Snapshot =====

  buildProjection(): CodexLinkProjection {
    const threads: ThreadProjection[] = [...this.threads.values()].map((t) => ({
      thread: t.thread,
      status: t.status,
      currentTurnId: t.currentTurnId,
      transcript: [...t.transcript],
      timeline: [...t.timeline],
      pendingApproval: t.pendingApproval,
      streamingAssistant: t.streamingAssistant,
    }));
    return {
      hostId: this.options.hostId,
      account: this.account,
      capabilities: this.capabilities,
      projects: [...this.projects],
      threads,
      latestSequence: asSequenceNumber(this.sequenceCounter),
      capturedAt: this.options.now(),
    };
  }

  private sendSnapshotTo(peer: { userId: UserId; deviceId: DeviceId }): void {
    const response: SessionSnapshotResponse = { projection: this.buildProjection() };
    this.options.peers.sendFrame(peer, { kind: "snapshot_response", response });
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

// Helper exposed for tests that want to construct refs.
export const helpers = {
  asProjectId,
  asThreadId,
  asTurnId,
  asRequestId,
} as const;

// ===== ApprovalDecisionKind ↔ Codex 文字列 =====

function decisionToCodex(decision: ApprovalDecisionKind): string {
  switch (decision) {
    case "accept":
      return "approved";
    case "accept_for_session":
      return "approved_for_session";
    case "decline":
      return "denied";
    case "cancel":
      return "abort";
  }
}

// referenced by linter type-check to keep ItemId import in use
const _itemIdMarker = null as unknown as ItemId;
void _itemIdMarker;
