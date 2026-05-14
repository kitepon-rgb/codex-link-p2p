// Session protocol — DataChannel 上だけで流れる型。
//
// このファイルに置くもの:
// - 親リポ (codex-link broker 版) と同等の CodexLinkEvent / Approval / Turn / Projection 型
// - CodexLinkSessionFrame (event / ui_action / snapshot_request / snapshot_response / ack の sum)
// - CodexLinkUIAction (iPhone → Host)
// - LiveActivityState (Live Activity の content state)
//
// この module は services/relay からの import を ESLint で禁止している
// (eslint.config.js の no-restricted-imports)。Relay は payload を観測しない
// ため、session を import すべきではない。

import type { DeviceId, HostId, HostPlatform, UserId } from "./rendezvous.js";

// ===== Branded IDs (session only) =====

export type ProjectId = string & { readonly __brand: "ProjectId" };
export type ThreadId = string & { readonly __brand: "ThreadId" };
export type TurnId = string & { readonly __brand: "TurnId" };
export type ItemId = string & { readonly __brand: "ItemId" };
export type RequestId = string & { readonly __brand: "RequestId" };
export type SequenceNumber = number & { readonly __brand: "SequenceNumber" };

export const asProjectId = (value: string): ProjectId => value as ProjectId;
export const asThreadId = (value: string): ThreadId => value as ThreadId;
export const asTurnId = (value: string): TurnId => value as TurnId;
export const asItemId = (value: string): ItemId => value as ItemId;
export const asRequestId = (value: string): RequestId => value as RequestId;
export const asSequenceNumber = (value: number): SequenceNumber =>
  value as SequenceNumber;

// ===== Host meta (Codex account / capabilities) =====

export interface HostChatGptAccount {
  readonly email: string;
  readonly planType: string | null;
}

export interface HostCapabilities {
  readonly hostId: HostId;
  readonly platform: HostPlatform;
  readonly codexVersion: string;
  readonly supportsApprovals: boolean;
}

// ===== Project / Thread / Turn refs =====

export interface ProjectRef {
  readonly id: ProjectId;
  readonly hostId: HostId;
  readonly name: string;
  readonly pathLabel: string;
}

export interface ThreadRef {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string | null;
  readonly updatedAt: string | null;
}

export interface TurnRef {
  readonly id: TurnId;
  readonly threadId: ThreadId;
}

// ===== Turn status =====
//
// 親リポと完全一致。Codex の `turn/started` → "running"、`turn/completed` → "completed"。

export type TurnStatus =
  | "idle"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "canceled";

// ===== Approval (4-way decision、親リポと完全一致) =====

export type ApprovalKind =
  | "command_execution"
  | "file_change"
  | "network"
  | "user_input";

export type ApprovalDecisionKind =
  | "accept"
  | "accept_for_session"
  | "decline"
  | "cancel";

export interface ApprovalRequest {
  readonly id: RequestId;
  readonly kind: ApprovalKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly itemId?: ItemId;
  readonly title: string;
  readonly detail: string;
  readonly availableDecisions: readonly ApprovalDecisionKind[];
}

export interface ApprovalDecision {
  readonly requestId: RequestId;
  readonly decision: ApprovalDecisionKind;
}

// ===== Transcript / Timeline pieces =====

export interface TranscriptItem {
  readonly id: ItemId;
  readonly role: "user" | "assistant";
  readonly text: string;
}

export type TimelineItemStatus = "running" | "completed" | "failed" | "declined";

export interface TimelineEntry {
  readonly itemId: ItemId;
  readonly turnId: TurnId;
  readonly label: string;
  readonly detail: string | null;
  readonly status: TimelineItemStatus;
}

// ===== Diagnostic =====

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface DiagnosticEvent {
  readonly scope: "host" | "relay" | "codex";
  readonly severity: DiagnosticSeverity;
  readonly message: string;
}

// ===== CodexLinkEvent (DataChannel-only discriminated union) =====
//
// event 自体は **sequence/timestamp を持たない** (親リポと同じ設計). 順序情報は
// SessionFrameEvent 側に乗せて DataChannel に流す.

export interface HostAccountUpdatedEvent {
  readonly type: "host.account.updated";
  readonly hostId: HostId;
  readonly account: HostChatGptAccount | null;
}

export interface HostCapabilitiesUpdatedEvent {
  readonly type: "host.capabilities.updated";
  readonly hostId: HostId;
  readonly capabilities: HostCapabilities;
}

export interface ProjectListUpdatedEvent {
  readonly type: "project.list.updated";
  readonly hostId: HostId;
  readonly projects: readonly ProjectRef[];
}

export interface ThreadStartedEvent {
  readonly type: "thread.started";
  readonly thread: ThreadRef;
}

export interface TurnStatusChangedEvent {
  readonly type: "turn.status.changed";
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly status: TurnStatus;
}

export interface AssistantDeltaEvent {
  readonly type: "assistant.delta";
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly text: string;
}

export interface AssistantFinalEvent {
  readonly type: "assistant.final";
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly itemId: ItemId;
  readonly text: string;
}

export interface TranscriptItemRecordedEvent {
  readonly type: "transcript.item.recorded";
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly itemId: ItemId;
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface TimelineItemStartedEvent {
  readonly type: "timeline.item.started";
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly itemId: ItemId;
  readonly label: string;
  detail?: string;
}

export interface TimelineItemCompletedEvent {
  readonly type: "timeline.item.completed";
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly itemId: ItemId;
  readonly status: "completed" | "failed" | "declined";
}

export interface ApprovalRequestedEvent {
  readonly type: "approval.requested";
  readonly request: ApprovalRequest;
}

export interface ApprovalResolvedEvent {
  readonly type: "approval.resolved";
  readonly requestId: RequestId;
  readonly decision?: ApprovalDecisionKind;
}

export interface RateLimitUpdatedEvent {
  readonly type: "rate_limit.updated";
  readonly userId: UserId;
  readonly usedPercent: number | null;
}

export interface DiagnosticReportedEvent {
  readonly type: "diagnostic.reported";
  readonly diagnostic: DiagnosticEvent;
}

export interface ErrorReportedEvent {
  readonly type: "error.reported";
  readonly scope: "host" | "relay" | "codex";
  readonly message: string;
}

export type CodexLinkEvent =
  | HostAccountUpdatedEvent
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
  | DiagnosticReportedEvent
  | ErrorReportedEvent;

// ===== iPhone → Host UI actions =====

export interface UISubmitTurn {
  readonly type: "ui.submit_turn";
  readonly projectId: ProjectId;
  readonly threadId: ThreadId | null;
  readonly input: string;
}

export interface UIRespondApproval {
  readonly type: "ui.respond_approval";
  readonly decision: ApprovalDecision;
}

export interface UICancelTurn {
  readonly type: "ui.cancel_turn";
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
}

export interface UISelectProject {
  readonly type: "ui.select_project";
  readonly projectId: ProjectId;
}

export interface UIResumeThread {
  readonly type: "ui.resume_thread";
  readonly threadId: ThreadId;
}

export type CodexLinkUIAction =
  | UISubmitTurn
  | UIRespondApproval
  | UICancelTurn
  | UISelectProject
  | UIResumeThread;

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
  readonly thread: ThreadRef;
  readonly status: TurnStatus;
  readonly currentTurnId: TurnId | null;
  readonly transcript: readonly TranscriptItem[];
  readonly timeline: readonly TimelineEntry[];
  readonly pendingApproval: ApprovalRequest | null;
  readonly streamingAssistant: string;
}

export interface CodexLinkProjection {
  readonly hostId: HostId;
  readonly account: HostChatGptAccount | null;
  readonly capabilities: HostCapabilities;
  readonly projects: readonly ProjectRef[];
  readonly threads: readonly ThreadProjection[];
  readonly latestSequence: SequenceNumber;
  readonly capturedAt: number;
}

export interface SessionSnapshotResponse {
  readonly projection: CodexLinkProjection;
}

// ===== Live Activity content state (iOS 17+) =====
//
// iPhone 側だけが使うが、ここに型を置いて TS / Swift wire を揃える.

export interface LiveActivityState {
  readonly hostName: string;
  readonly projectName: string;
  readonly status: TurnStatus;
  readonly latestText: string | null;
  readonly approvalRequired: boolean;
}

// ===== Session frame (DataChannel wire) =====

export interface SessionFrameEvent {
  readonly kind: "event";
  readonly sequence: SequenceNumber;
  readonly timestamp: number;
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
