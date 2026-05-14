import { describe, expect, it } from "vitest";

import { asHostId, asDeviceId, asUserId } from "../src/rendezvous.js";
import {
  asItemId,
  asProjectId,
  asRequestId,
  asSequenceNumber,
  asThreadId,
  asTurnId,
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
const projectId = asProjectId("proj-1");
const threadId = asThreadId("thread-1");
const turnId = asTurnId("turn-1");
const itemId = asItemId("item-1");
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
      threadId,
      turnId,
      text: "hello ",
    };

    const decoded = JSON.parse(JSON.stringify(ev)) as AssistantDeltaEvent;
    expect(decoded.type).toBe("assistant.delta");
    expect(decoded.text).toBe("hello ");
    expect(decoded.threadId).toBe(threadId);
  });

  it("JSON round-trips a ThreadStartedEvent", () => {
    const ev: ThreadStartedEvent = {
      type: "thread.started",
      thread: {
        id: threadId,
        projectId,
        title: "First thread",
        updatedAt: null,
      },
    };
    const decoded = JSON.parse(JSON.stringify(ev)) as ThreadStartedEvent;
    expect(decoded.thread.title).toBe("First thread");
  });

  it("a switch over CodexLinkEvent.type is exhaustive (no implicit any in never branch)", () => {
    const classify = (e: CodexLinkEvent): string => {
      switch (e.type) {
        case "host.account.updated":
          return e.account?.email ?? "no-account";
        case "host.capabilities.updated":
          return e.capabilities.codexVersion;
        case "project.list.updated":
          return `${e.projects.length} projects`;
        case "thread.started":
          return e.thread.title ?? "untitled";
        case "turn.status.changed":
          return e.status;
        case "assistant.delta":
          return e.text;
        case "assistant.final":
          return e.text;
        case "transcript.item.recorded":
          return e.role;
        case "timeline.item.started":
          return e.label;
        case "timeline.item.completed":
          return e.status;
        case "approval.requested":
          return e.request.title;
        case "approval.resolved":
          return e.decision ?? "no-decision";
        case "rate_limit.updated":
          return String(e.usedPercent ?? -1);
        case "diagnostic.reported":
          return e.diagnostic.message;
        case "error.reported":
          return e.message;
      }
      // Exhaustiveness check — if a new CodexLinkEvent variant is added,
      // this assignment fails to typecheck.
      const _never: never = e;
      return _never;
    };

    const ev: AssistantDeltaEvent = {
      type: "assistant.delta",
      threadId,
      turnId,
      text: "hi",
    };
    expect(classify(ev)).toBe("hi");
  });
});

describe("ApprovalRequest / ApprovalDecision (4-way)", () => {
  it("round-trips a command_execution approval request and decision", () => {
    const req: ApprovalRequest = {
      id: requestId,
      kind: "command_execution",
      threadId,
      turnId,
      title: "rm -rf /tmp/junk",
      detail: "Will delete /tmp/junk recursively.",
      availableDecisions: ["accept", "accept_for_session", "decline", "cancel"],
    };
    const decision: ApprovalDecision = {
      requestId,
      decision: "decline",
    };

    const dr = JSON.parse(JSON.stringify(req)) as ApprovalRequest;
    const dd = JSON.parse(JSON.stringify(decision)) as ApprovalDecision;
    expect(dr.kind).toBe("command_execution");
    expect(dr.availableDecisions).toContain("accept_for_session");
    expect(dd.decision).toBe("decline");
  });
});

describe("CodexLinkUIAction", () => {
  it("submit_turn frame carries projectId + input", () => {
    const action: CodexLinkUIAction = {
      type: "ui.submit_turn",
      projectId,
      threadId: null,
      input: "Refactor session.ts",
    };
    const decoded = JSON.parse(JSON.stringify(action)) as CodexLinkUIAction;
    expect(decoded.type).toBe("ui.submit_turn");
    if (decoded.type === "ui.submit_turn") {
      expect(decoded.input).toBe("Refactor session.ts");
      expect(decoded.projectId).toBe(projectId);
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
      account: null,
      capabilities: sampleCapabilities,
      projects: [
        { id: projectId, hostId, name: "Codex", pathLabel: "/tmp/codex" },
      ],
      threads: [
        {
          thread: { id: threadId, projectId, title: "thread A", updatedAt: null },
          status: "idle",
          currentTurnId: null,
          transcript: [{ id: itemId, role: "user", text: "hi" }],
          timeline: [],
          pendingApproval: null,
          streamingAssistant: "",
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
    expect(dr.projection.threads[0]?.transcript[0]?.text).toBe("hi");
  });
});

describe("CodexLinkSessionFrame (DataChannel wire)", () => {
  it("each frame kind is discriminable after JSON round-trip", () => {
    const frames: CodexLinkSessionFrame[] = [
      {
        kind: "event",
        sequence: asSequenceNumber(1),
        timestamp: 0,
        event: {
          type: "assistant.delta",
          threadId,
          turnId,
          text: "x",
        },
      },
      {
        kind: "ui_action",
        action: { type: "ui.cancel_turn", threadId, turnId },
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
