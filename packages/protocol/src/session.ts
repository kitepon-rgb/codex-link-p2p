// Session protocol — DataChannel 上だけで流れる型。
//
// このファイルに置くもの:
// - CodexLinkEvent (host.online は rendezvous 側、それ以外の DataChannel 上 event)
// - CodexLinkSessionFrame (event / ui_action / snapshot_request / snapshot_response / ack の sum)
// - CodexLinkUIAction (iPhone → Host)
// - ApprovalRequest / ApprovalDecision
// - SessionSnapshotRequest / SessionSnapshotResponse (replay-on-peer)
// - CodexLinkProjection (Host が iPhone へ返す現状 snapshot)
//
// この module は services/relay からの import を ESLint で禁止している
// (eslint.config.js の no-restricted-imports)。Relay は payload を観測しない
// ため、session を import すべきではない。

import type { DeviceId, HostId, HostPlatform, UserId } from "./rendezvous.js";

// ===== Branded IDs (session only) =====

export type ThreadId = string & { readonly __brand: "ThreadId" };
export type RequestId = string & { readonly __brand: "RequestId" };
export type SequenceNumber = number & { readonly __brand: "SequenceNumber" };

export const asThreadId = (value: string): ThreadId => value as ThreadId;
export const asRequestId = (value: string): RequestId => value as RequestId;
export const asSequenceNumber = (value: number): SequenceNumber =>
  value as SequenceNumber;

// ===== Host capabilities / project descriptor =====

export interface HostCapabilities {
  readonly hostId: HostId;
  readonly platform: HostPlatform;
  readonly codexVersion: string;
  readonly supportsApprovals: boolean;
}

export interface ProjectDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly path: string;
}

// ===== Transcript / Timeline projection pieces =====

export interface TranscriptItem {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
}

export type TimelineItemKind = "tool_call" | "approval" | "reasoning";

export type TimelineItemOutcome = "success" | "failure" | "cancelled";

export interface TimelineEntry {
  readonly itemId: string;
  readonly kind: TimelineItemKind;
  readonly label: string;
  readonly outcome: TimelineItemOutcome | null;
}

// ===== Approval =====

export type ApprovalKind = "command" | "patch" | "file_write" | "network";

export interface ApprovalRequest {
  readonly requestId: RequestId;
  readonly threadId: ThreadId;
  readonly summary: string;
  readonly kind: ApprovalKind;
  readonly detail: string;
}

export interface ApprovalDecision {
  readonly requestId: RequestId;
  readonly approved: boolean;
  readonly reason?: string;
}

// ===== CodexLinkEvent (DataChannel-only discriminated union) =====
//
// すべての event に sequence と timestamp を持たせる (順序保証 + ack 用)。

interface BaseEvent {
  readonly sequence: SequenceNumber;
  readonly timestamp: number;
}

export type TurnStatus =
  | "idle"
  | "thinking"
  | "tool"
  | "awaiting_approval"
  | "error";

export interface HostCapabilitiesUpdatedEvent extends BaseEvent {
  readonly type: "host.capabilities.updated";
  readonly capabilities: HostCapabilities;
}

export interface ProjectListUpdatedEvent extends BaseEvent {
  readonly type: "project.list.updated";
  readonly projects: readonly ProjectDescriptor[];
}

export interface ThreadStartedEvent extends BaseEvent {
  readonly type: "thread.started";
  readonly threadId: ThreadId;
  readonly projectId: string;
  readonly title: string;
}

export interface TurnStatusChangedEvent extends BaseEvent {
  readonly type: "turn.status.changed";
  readonly threadId: ThreadId;
  readonly status: TurnStatus;
}

export interface AssistantDeltaEvent extends BaseEvent {
  readonly type: "assistant.delta";
  readonly threadId: ThreadId;
  readonly delta: string;
}

export interface AssistantFinalEvent extends BaseEvent {
  readonly type: "assistant.final";
  readonly threadId: ThreadId;
  readonly text: string;
}

export interface TranscriptItemRecordedEvent extends BaseEvent {
  readonly type: "transcript.item.recorded";
  readonly threadId: ThreadId;
  readonly item: TranscriptItem;
}

export interface TimelineItemStartedEvent extends BaseEvent {
  readonly type: "timeline.item.started";
  readonly threadId: ThreadId;
  readonly itemId: string;
  readonly kind: TimelineItemKind;
  readonly label: string;
}

export interface TimelineItemCompletedEvent extends BaseEvent {
  readonly type: "timeline.item.completed";
  readonly threadId: ThreadId;
  readonly itemId: string;
  readonly outcome: TimelineItemOutcome;
}

export interface ApprovalRequestedEvent extends BaseEvent {
  readonly type: "approval.requested";
  readonly request: ApprovalRequest;
}

export interface ApprovalResolvedEvent extends BaseEvent {
  readonly type: "approval.resolved";
  readonly threadId: ThreadId;
  readonly decision: ApprovalDecision;
}

export interface RateLimitUpdatedEvent extends BaseEvent {
  readonly type: "rate_limit.updated";
  readonly remainingTokens: number;
  readonly resetAt: number;
}

export interface ErrorReportedEvent extends BaseEvent {
  readonly type: "error.reported";
  readonly threadId?: ThreadId;
  readonly code: string;
  readonly message: string;
}

export type CodexLinkEvent =
  | HostCapabilitiesUpdatedEvent
  | ProjectListUpdatedEvent
  | ThreadStartedEvent
  | TurnStatusChangedEvent
  | AssistantDeltaEvent
  | AssistantFinalEvent
  | TranscriptItemRecordedEvent
  | TimelineItemStartedEvent
  | TimelineItemCompletedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | RateLimitUpdatedEvent
  | ErrorReportedEvent;

// ===== iPhone → Host UI actions =====

export interface UISubmitTurn {
  readonly type: "ui.submit_turn";
  readonly threadId: ThreadId;
  readonly input: string;
}

export interface UIRespondApproval {
  readonly type: "ui.respond_approval";
  readonly decision: ApprovalDecision;
}

export interface UICancelTurn {
  readonly type: "ui.cancel_turn";
  readonly threadId: ThreadId;
}

export interface UISelectProject {
  readonly type: "ui.select_project";
  readonly projectId: string;
}

export type CodexLinkUIAction =
  | UISubmitTurn
  | UIRespondApproval
  | UICancelTurn
  | UISelectProject;

// ===== Snapshot (replay-on-peer) =====
//
// iPhone は peer 確立直後に snapshot を要求し、Host は現状の projection を
// 1 メッセージで返す。これにより Relay 側に event cache を持たずに済む。

export interface SessionSnapshotRequest {
  readonly fromUserId: UserId;
  readonly fromDeviceId: DeviceId;
  readonly hostId: HostId;
  readonly lastSequence: SequenceNumber | null;
}

export interface ThreadProjection {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly status: TurnStatus;
  readonly transcript: readonly TranscriptItem[];
  readonly timeline: readonly TimelineEntry[];
  readonly pendingApproval: ApprovalRequest | null;
}

export interface CodexLinkProjection {
  readonly hostId: HostId;
  readonly capabilities: HostCapabilities;
  readonly projects: readonly ProjectDescriptor[];
  readonly threads: readonly ThreadProjection[];
  readonly latestSequence: SequenceNumber;
  readonly capturedAt: number;
}

export interface SessionSnapshotResponse {
  readonly projection: CodexLinkProjection;
}

// ===== Session frame (DataChannel wire) =====

export interface SessionFrameEvent {
  readonly kind: "event";
  readonly event: CodexLinkEvent;
}

export interface SessionFrameUIAction {
  readonly kind: "ui_action";
  readonly action: CodexLinkUIAction;
}

export interface SessionFrameSnapshotRequest {
  readonly kind: "snapshot_request";
  readonly request: SessionSnapshotRequest;
}

export interface SessionFrameSnapshotResponse {
  readonly kind: "snapshot_response";
  readonly response: SessionSnapshotResponse;
}

export interface SessionFrameAck {
  readonly kind: "ack";
  readonly sequence: SequenceNumber;
}

export type CodexLinkSessionFrame =
  | SessionFrameEvent
  | SessionFrameUIAction
  | SessionFrameSnapshotRequest
  | SessionFrameSnapshotResponse
  | SessionFrameAck;
