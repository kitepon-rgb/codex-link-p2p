import { describe, expect, it } from "vitest";

import {
  asSequenceNumber,
  type CodexLinkEvent,
} from "@codex-link/protocol/session";

import {
  normalizeCodexEvent,
  type NormalizerContext,
} from "../src/codex-events.js";
import type { CodexAppServerEvent } from "../src/codex.js";

const ctx: NormalizerContext = {
  sequence: asSequenceNumber(1),
  timestamp: 1_700_000_000_000,
};

const normalize = (raw: CodexAppServerEvent): CodexLinkEvent | null =>
  normalizeCodexEvent(raw, ctx);

describe("normalizeCodexEvent", () => {
  it("maps thread_started → thread.started with defaults", () => {
    const ev = normalize({
      type: "thread_started",
      threadId: "t1",
      data: { projectId: "p1", title: "First" },
    });
    expect(ev).not.toBeNull();
    expect(ev?.type).toBe("thread.started");
    if (ev?.type === "thread.started") {
      expect(ev.threadId).toBe("t1");
      expect(ev.projectId).toBe("p1");
      expect(ev.title).toBe("First");
    }
  });

  it("maps assistant_message_delta → assistant.delta", () => {
    const ev = normalize({
      type: "assistant_message_delta",
      threadId: "t1",
      data: { delta: "hello " },
    });
    expect(ev?.type).toBe("assistant.delta");
    if (ev?.type === "assistant.delta") expect(ev.delta).toBe("hello ");
  });

  it("maps assistant_message → assistant.final", () => {
    const ev = normalize({
      type: "assistant_message",
      threadId: "t1",
      data: { text: "done" },
    });
    expect(ev?.type).toBe("assistant.final");
  });

  it("maps task_started → turn.status.changed thinking", () => {
    const ev = normalize({ type: "task_started", threadId: "t1" });
    if (ev?.type === "turn.status.changed") expect(ev.status).toBe("thinking");
  });

  it("maps task_complete → turn.status.changed idle", () => {
    const ev = normalize({ type: "task_complete", threadId: "t1" });
    if (ev?.type === "turn.status.changed") expect(ev.status).toBe("idle");
  });

  it("maps explicit turn_status with custom status", () => {
    const ev = normalize({
      type: "turn_status",
      threadId: "t1",
      data: { status: "awaiting_approval" },
    });
    if (ev?.type === "turn.status.changed")
      expect(ev.status).toBe("awaiting_approval");
  });

  it("maps timeline_item_started + completed with outcome mapping", () => {
    const started = normalize({
      type: "timeline_item_started",
      threadId: "t1",
      id: "i1",
      data: { kind: "tool_call", label: "shell" },
    });
    if (started?.type === "timeline.item.started") {
      expect(started.itemId).toBe("i1");
      expect(started.kind).toBe("tool_call");
      expect(started.label).toBe("shell");
    }

    const completed = normalize({
      type: "timeline_item_completed",
      threadId: "t1",
      id: "i1",
      data: { outcome: "succeeded" },
    });
    if (completed?.type === "timeline.item.completed")
      expect(completed.outcome).toBe("success");
  });

  it("maps approval_request with kind inference", () => {
    const ev = normalize({
      type: "apply_patch_approval_request",
      threadId: "t1",
      id: "r1",
      data: { summary: "patch foo", detail: "diff" },
    });
    if (ev?.type === "approval.requested") {
      expect(ev.request.requestId).toBe("r1");
      expect(ev.request.kind).toBe("patch");
      expect(ev.request.summary).toBe("patch foo");
    }
  });

  it("maps approval_resolved with reason", () => {
    const ev = normalize({
      type: "approval_resolved",
      threadId: "t1",
      data: { requestId: "r1", approved: true, reason: "looks fine" },
    });
    if (ev?.type === "approval.resolved") {
      expect(ev.decision.approved).toBe(true);
      expect(ev.decision.reason).toBe("looks fine");
    }
  });

  it("maps transcript_item_recorded preserving role", () => {
    const ev = normalize({
      type: "transcript_item_recorded",
      threadId: "t1",
      data: { role: "user", content: "hello" },
    });
    if (ev?.type === "transcript.item.recorded") {
      expect(ev.item.role).toBe("user");
      expect(ev.item.content).toBe("hello");
    }
  });

  it("returns null for unknown event types", () => {
    expect(normalize({ type: "totally.unknown" })).toBeNull();
  });

  it("rate_limit_updated maps numerics", () => {
    const ev = normalize({
      type: "rate_limit_updated",
      data: { remaining: 100, resetAt: 1_700_000_000_500 },
    });
    if (ev?.type === "rate_limit.updated") {
      expect(ev.remainingTokens).toBe(100);
      expect(ev.resetAt).toBe(1_700_000_000_500);
    }
  });

  it("error maps with optional threadId and message", () => {
    const ev = normalize({
      type: "error",
      data: { code: "boom", message: "blew up", threadId: "t1" },
    });
    if (ev?.type === "error.reported") {
      expect(ev.code).toBe("boom");
      expect(ev.message).toBe("blew up");
      expect(ev.threadId).toBe("t1");
    }
  });

  it("project_list_updated drops malformed items", () => {
    const ev = normalize({
      type: "project_list_updated",
      data: {
        projects: [
          { id: "p1", displayName: "P1", path: "/tmp/p1" },
          { id: "bad-no-path", displayName: "X" }, // dropped
        ],
      },
    });
    if (ev?.type === "project.list.updated") {
      expect(ev.projects).toHaveLength(1);
      expect(ev.projects[0]?.id).toBe("p1");
    }
  });
});
