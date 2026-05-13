import { describe, expect, it } from "vitest";

import { asHostId, asDeviceId, asUserId } from "../src/rendezvous.js";
import {
  asRequestId,
  asSequenceNumber,
  asThreadId,
  type ApprovalDecision,
  type ApprovalRequest,
  type AssistantDeltaEvent,
  type CodexLinkEvent,
  type CodexLinkProjection,
  type CodexLinkSessionFrame,
  type CodexLinkUIAction,
  type HostCapabilities,
  type SessionSnapshotRequest,
  type SessionSnapshotResponse,
  type ThreadStartedEvent,
} from "../src/session.js";

const hostId = asHostId("host-1");
const threadId = asThreadId("thread-1");
const requestId = asRequestId("req-1");

const sampleCapabilities: HostCapabilities = {
  hostId,
  platform: "macos",
  codexVersion: "0.0.0-dev",
  supportsApprovals: true,
};

describe("CodexLinkEvent discriminated union", () => {
  it("JSON round-trips a representative AssistantDeltaEvent", () => {
    const ev: AssistantDeltaEvent = {
      type: "assistant.delta",
      sequence: asSequenceNumber(1),
      timestamp: 1_700_000_000_000,
      threadId,
      delta: "hello ",
    };

    const decoded = JSON.parse(JSON.stringify(ev)) as AssistantDeltaEvent;
    expect(decoded.type).toBe("assistant.delta");
    expect(decoded.delta).toBe("hello ");
    expect(decoded.threadId).toBe(threadId);
  });

  it("JSON round-trips a ThreadStartedEvent", () => {
    const ev: ThreadStartedEvent = {
      type: "thread.started",
      sequence: asSequenceNumber(2),
      timestamp: 1_700_000_000_001,
      threadId,
      projectId: "proj-1",
      title: "First thread",
    };
    const decoded = JSON.parse(JSON.stringify(ev)) as ThreadStartedEvent;
    expect(decoded.title).toBe("First thread");
  });

  it("a switch over CodexLinkEvent.type is exhaustive (no implicit any in never branch)", () => {
    const classify = (e: CodexLinkEvent): string => {
      switch (e.type) {
        case "host.capabilities.updated":
          return e.capabilities.codexVersion;
        case "project.list.updated":
          return `${e.projects.length} projects`;
        case "thread.started":
          return e.title;
        case "turn.status.changed":
          return e.status;
        case "assistant.delta":
          return e.delta;
        case "assistant.final":
          return e.text;
        case "transcript.item.recorded":
          return e.item.role;
        case "timeline.item.started":
          return e.kind;
        case "timeline.item.completed":
          return e.outcome;
        case "approval.requested":
          return e.request.summary;
        case "approval.resolved":
          return e.decision.approved ? "approved" : "denied";
        case "rate_limit.updated":
          return String(e.remainingTokens);
        case "error.reported":
          return e.code;
      }
      // Exhaustiveness check — if a new CodexLinkEvent variant is added,
      // this assignment fails to typecheck.
      const _never: never = e;
      return _never;
    };

    const ev: AssistantDeltaEvent = {
      type: "assistant.delta",
      sequence: asSequenceNumber(1),
      timestamp: 0,
      threadId,
      delta: "hi",
    };
    expect(classify(ev)).toBe("hi");
  });
});

describe("ApprovalRequest / ApprovalDecision", () => {
  it("round-trips a command approval request and decision", () => {
    const req: ApprovalRequest = {
      requestId,
      threadId,
      summary: "rm -rf /tmp/junk",
      kind: "command",
      detail: "Will delete /tmp/junk recursively.",
    };
    const decision: ApprovalDecision = {
      requestId,
      approved: false,
      reason: "Looks unsafe",
    };

    const dr = JSON.parse(JSON.stringify(req)) as ApprovalRequest;
    const dd = JSON.parse(JSON.stringify(decision)) as ApprovalDecision;
    expect(dr.kind).toBe("command");
    expect(dd.approved).toBe(false);
    expect(dd.reason).toBe("Looks unsafe");
  });
});

describe("CodexLinkUIAction", () => {
  it("submit_turn frame carries the input text", () => {
    const action: CodexLinkUIAction = {
      type: "ui.submit_turn",
      threadId,
      input: "Refactor session.ts",
    };
    const decoded = JSON.parse(JSON.stringify(action)) as CodexLinkUIAction;
    expect(decoded.type).toBe("ui.submit_turn");
    if (decoded.type === "ui.submit_turn") {
      expect(decoded.input).toBe("Refactor session.ts");
    }
  });
});

describe("Snapshot (replay-on-peer)", () => {
  it("request and response round-trip with a non-empty projection", () => {
    const request: SessionSnapshotRequest = {
      fromUserId: asUserId("user-1"),
      fromDeviceId: asDeviceId("device-1"),
      hostId,
      lastSequence: null,
    };

    const projection: CodexLinkProjection = {
      hostId,
      capabilities: sampleCapabilities,
      projects: [{ id: "p", displayName: "Codex", path: "/tmp/codex" }],
      threads: [
        {
          threadId,
          title: "thread A",
          status: "idle",
          transcript: [{ id: "i1", role: "user", content: "hi" }],
          timeline: [],
          pendingApproval: null,
        },
      ],
      latestSequence: asSequenceNumber(42),
      capturedAt: 1_700_000_000_000,
    };

    const response: SessionSnapshotResponse = { projection };

    const dq = JSON.parse(JSON.stringify(request)) as SessionSnapshotRequest;
    const dr = JSON.parse(JSON.stringify(response)) as SessionSnapshotResponse;

    expect(dq.lastSequence).toBeNull();
    expect(dr.projection.threads).toHaveLength(1);
    expect(dr.projection.threads[0]?.transcript[0]?.content).toBe("hi");
  });
});

describe("CodexLinkSessionFrame (DataChannel wire)", () => {
  it("each frame kind is discriminable after JSON round-trip", () => {
    const frames: CodexLinkSessionFrame[] = [
      {
        kind: "event",
        event: {
          type: "assistant.delta",
          sequence: asSequenceNumber(1),
          timestamp: 0,
          threadId,
          delta: "x",
        },
      },
      {
        kind: "ui_action",
        action: { type: "ui.cancel_turn", threadId },
      },
      {
        kind: "snapshot_request",
        request: {
          fromUserId: asUserId("u"),
          fromDeviceId: asDeviceId("d"),
          hostId,
          lastSequence: asSequenceNumber(5),
        },
      },
      { kind: "ack", sequence: asSequenceNumber(7) },
    ];

    const decoded = frames.map(
      (f) => JSON.parse(JSON.stringify(f)) as CodexLinkSessionFrame,
    );
    expect(decoded.map((f) => f.kind)).toEqual([
      "event",
      "ui_action",
      "snapshot_request",
      "ack",
    ]);
  });

  it("exhaustive switch over CodexLinkSessionFrame.kind", () => {
    const classify = (f: CodexLinkSessionFrame): string => {
      switch (f.kind) {
        case "event":
          return f.event.type;
        case "ui_action":
          return f.action.type;
        case "snapshot_request":
          return "snapshot_request";
        case "snapshot_response":
          return "snapshot_response";
        case "ack":
          return `ack:${f.sequence}`;
      }
      const _never: never = f;
      return _never;
    };

    expect(classify({ kind: "ack", sequence: asSequenceNumber(3) })).toBe(
      "ack:3",
    );
  });
});
