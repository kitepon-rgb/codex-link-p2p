// Codex app-server から受け取る生 event を CodexLinkEvent (session protocol)
// に正規化する pure function.
//
// 設計:
// - 入力: CodexAppServerEvent (type + data + threadId + id).
// - 出力: CodexLinkEvent 1 件 (もしくは null = 無視すべき event).
// - sequence / timestamp は外から渡される (event 順序保証を Host が中央管理).
// - 既知の Codex event 種別は限定的に扱い、未知のものは null を返して捨てる
//   (broker でないため Relay に流す必要なし、Host で完結).
//
// Codex app-server の正式な event 名はバージョンに依存する. 本ファイルは
// 「想定される代表名」をベースに mapping し、後続の Phase 6 で実機の event 名
// に合わせて調整する.

import type {
  ApprovalKind,
  ApprovalRequest,
  CodexLinkEvent,
  HostCapabilities,
  RequestId,
  SequenceNumber,
  ThreadId,
  TimelineItemKind,
  TimelineItemOutcome,
  TurnStatus,
} from "@codex-link/protocol/session";
import {
  asRequestId,
  asThreadId,
} from "@codex-link/protocol/session";

import type { CodexAppServerEvent } from "./codex.js";

export interface NormalizerContext {
  readonly sequence: SequenceNumber;
  readonly timestamp: number;
}

const data = (e: CodexAppServerEvent): Record<string, unknown> =>
  e.data ?? {};

const asString = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : fallback;

const asNumber = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const asBool = (v: unknown, fallback = false): boolean =>
  typeof v === "boolean" ? v : fallback;

const requireThreadId = (e: CodexAppServerEvent): ThreadId =>
  asThreadId(asString(e.threadId ?? data(e)["threadId"], "thread_unknown"));

const TURN_STATUS_MAP: Record<string, TurnStatus> = {
  idle: "idle",
  running: "thinking",
  thinking: "thinking",
  tool: "tool",
  tool_call: "tool",
  awaiting_approval: "awaiting_approval",
  awaiting_user_approval: "awaiting_approval",
  error: "error",
  failed: "error",
};

const TIMELINE_KIND_MAP: Record<string, TimelineItemKind> = {
  tool_call: "tool_call",
  tool: "tool_call",
  approval: "approval",
  approval_request: "approval",
  reasoning: "reasoning",
  thinking: "reasoning",
};

const TIMELINE_OUTCOME_MAP: Record<string, TimelineItemOutcome> = {
  success: "success",
  succeeded: "success",
  ok: "success",
  failure: "failure",
  failed: "failure",
  error: "failure",
  cancelled: "cancelled",
  canceled: "cancelled",
};

const APPROVAL_KIND_MAP: Record<string, ApprovalKind> = {
  command: "command",
  exec: "command",
  exec_command: "command",
  patch: "patch",
  apply_patch: "patch",
  file_write: "file_write",
  write_file: "file_write",
  network: "network",
};

const mapTurnStatus = (raw: string): TurnStatus =>
  TURN_STATUS_MAP[raw] ?? "thinking";

const mapTimelineKind = (raw: string): TimelineItemKind =>
  TIMELINE_KIND_MAP[raw] ?? "tool_call";

const mapTimelineOutcome = (raw: string): TimelineItemOutcome =>
  TIMELINE_OUTCOME_MAP[raw] ?? "success";

const mapApprovalKind = (raw: string): ApprovalKind =>
  APPROVAL_KIND_MAP[raw] ?? "command";

export const normalizeCodexEvent = (
  raw: CodexAppServerEvent,
  ctx: NormalizerContext,
): CodexLinkEvent | null => {
  const d = data(raw);
  const base = { sequence: ctx.sequence, timestamp: ctx.timestamp } as const;

  switch (raw.type) {
    case "thread_started":
    case "thread.started":
    case "session.created": {
      return {
        ...base,
        type: "thread.started",
        threadId: requireThreadId(raw),
        projectId: asString(d["projectId"], asString(d["project_id"], "default")),
        title: asString(d["title"], "New thread"),
      };
    }

    case "turn_started":
    case "turn.started":
    case "task_started":
      return {
        ...base,
        type: "turn.status.changed",
        threadId: requireThreadId(raw),
        status: "thinking",
      };

    case "turn_complete":
    case "turn.complete":
    case "task_complete":
      return {
        ...base,
        type: "turn.status.changed",
        threadId: requireThreadId(raw),
        status: "idle",
      };

    case "turn_status":
    case "turn.status":
      return {
        ...base,
        type: "turn.status.changed",
        threadId: requireThreadId(raw),
        status: mapTurnStatus(asString(d["status"], "thinking")),
      };

    case "assistant_message_delta":
    case "agent_message_delta":
    case "assistant.delta":
      return {
        ...base,
        type: "assistant.delta",
        threadId: requireThreadId(raw),
        delta: asString(d["delta"] ?? d["text"], ""),
      };

    case "assistant_message":
    case "agent_message":
    case "assistant.final":
      return {
        ...base,
        type: "assistant.final",
        threadId: requireThreadId(raw),
        text: asString(d["text"] ?? d["content"], ""),
      };

    case "transcript_item_recorded":
    case "transcript.item":
    case "history_item": {
      const role = asString(d["role"], "assistant");
      const allowedRoles: Array<"user" | "assistant" | "system"> = [
        "user",
        "assistant",
        "system",
      ];
      const safeRole = (allowedRoles as readonly string[]).includes(role)
        ? (role as "user" | "assistant" | "system")
        : "assistant";
      return {
        ...base,
        type: "transcript.item.recorded",
        threadId: requireThreadId(raw),
        item: {
          id: asString(raw.id ?? d["id"], `i_${ctx.sequence}`),
          role: safeRole,
          content: asString(d["content"] ?? d["text"], ""),
        },
      };
    }

    case "timeline_item_started":
    case "timeline.item.started":
    case "tool_call_started":
      return {
        ...base,
        type: "timeline.item.started",
        threadId: requireThreadId(raw),
        itemId: asString(d["itemId"] ?? raw.id, `t_${ctx.sequence}`),
        kind: mapTimelineKind(asString(d["kind"], "tool_call")),
        label: asString(d["label"] ?? d["name"], "tool"),
      };

    case "timeline_item_completed":
    case "timeline.item.completed":
    case "tool_call_completed":
      return {
        ...base,
        type: "timeline.item.completed",
        threadId: requireThreadId(raw),
        itemId: asString(d["itemId"] ?? raw.id, `t_${ctx.sequence}`),
        outcome: mapTimelineOutcome(asString(d["outcome"], "success")),
      };

    case "approval_request":
    case "apply_patch_approval_request":
    case "exec_command_approval_request":
    case "approval.requested": {
      const approval: ApprovalRequest = {
        requestId: asRequestId(asString(d["requestId"] ?? raw.id, `r_${ctx.sequence}`)),
        threadId: requireThreadId(raw),
        summary: asString(d["summary"] ?? d["title"], "Approval requested"),
        kind: mapApprovalKind(
          asString(
            d["kind"] ?? d["type"],
            raw.type === "apply_patch_approval_request" ? "patch" : "command",
          ),
        ),
        detail: asString(d["detail"] ?? d["body"], ""),
      };
      return {
        ...base,
        type: "approval.requested",
        request: approval,
      };
    }

    case "approval_resolved":
    case "approval.resolved":
      return {
        ...base,
        type: "approval.resolved",
        threadId: requireThreadId(raw),
        decision: {
          requestId: asRequestId(
            asString(d["requestId"] ?? raw.id, `r_${ctx.sequence}`),
          ) as RequestId,
          approved: asBool(d["approved"], false),
          ...(typeof d["reason"] === "string"
            ? { reason: d["reason"] as string }
            : {}),
        },
      };

    case "rate_limit_updated":
    case "rate_limit.updated":
      return {
        ...base,
        type: "rate_limit.updated",
        remainingTokens: asNumber(d["remainingTokens"] ?? d["remaining"], 0),
        resetAt: asNumber(d["resetAt"] ?? d["reset_at"], 0),
      };

    case "error":
    case "error.reported": {
      const code = asString(d["code"], "unknown");
      const message = asString(d["message"], "");
      const threadIdRaw = asString(d["threadId"] ?? raw.threadId, "");
      return {
        ...base,
        type: "error.reported",
        ...(threadIdRaw.length > 0 ? { threadId: asThreadId(threadIdRaw) } : {}),
        code,
        message,
      };
    }

    case "host_capabilities_updated":
    case "host.capabilities.updated": {
      const capRaw = d["capabilities"];
      if (
        typeof capRaw === "object" &&
        capRaw !== null &&
        "hostId" in capRaw
      ) {
        return {
          ...base,
          type: "host.capabilities.updated",
          capabilities: capRaw as unknown as HostCapabilities,
        };
      }
      return null;
    }

    case "project_list_updated":
    case "project.list.updated": {
      const projects = d["projects"];
      if (Array.isArray(projects)) {
        return {
          ...base,
          type: "project.list.updated",
          projects: projects.filter(
            (p): p is { id: string; displayName: string; path: string } =>
              typeof p === "object" &&
              p !== null &&
              typeof (p as Record<string, unknown>)["id"] === "string" &&
              typeof (p as Record<string, unknown>)["displayName"] === "string" &&
              typeof (p as Record<string, unknown>)["path"] === "string",
          ),
        };
      }
      return null;
    }

    default:
      return null;
  }
};
