// Codex notification → CodexLinkEvent 正規化テスト. broker 版から移植した
// codex-events.ts の API (codexNotificationToEvents / codexServerRequestToEvent)
// を、代表的な Codex notification と server request で検証.

import { describe, expect, it } from "vitest";

import {
  codexNotificationToEvents,
  codexServerRequestToEvent,
} from "../src/codex-events.js";
import { asProjectId } from "@codex-link/protocol/session";
import type { JsonRpcNotification, JsonRpcServerRequest } from "@codex-link/codex-client";

const projectId = asProjectId("test-proj");

describe("codexNotificationToEvents", () => {
  it("normalizes thread/started", () => {
    const n: JsonRpcNotification = {
      method: "thread/started",
      params: {
        thread: { id: "th-1", name: "Hello", updatedAt: "2026-05-14T00:00:00Z" },
      },
    };
    const events = codexNotificationToEvents(n, projectId);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.type).toBe("thread.started");
    if (e.type === "thread.started") {
      expect(e.thread.id).toBe("th-1");
      expect(e.thread.projectId).toBe(projectId);
      expect(e.thread.title).toBe("Hello");
    }
  });

  it("normalizes turn/started to turn.status.changed running", () => {
    const n: JsonRpcNotification = {
      method: "turn/started",
      params: { threadId: "th-1", turn: { id: "t-1", status: "running" } },
    };
    const events = codexNotificationToEvents(n, projectId);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.type).toBe("turn.status.changed");
    if (e.type === "turn.status.changed") {
      expect(e.threadId).toBe("th-1");
      expect(e.turnId).toBe("t-1");
      expect(e.status).toBe("running");
    }
  });

  it("normalizes item/agentMessage/delta to assistant.delta", () => {
    const n: JsonRpcNotification = {
      method: "item/agentMessage/delta",
      params: { threadId: "th-1", turnId: "t-1", delta: "hello " },
    };
    const events = codexNotificationToEvents(n, projectId);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.type).toBe("assistant.delta");
    if (e.type === "assistant.delta") {
      expect(e.text).toBe("hello ");
    }
  });

  it("returns [] for unknown method", () => {
    const n: JsonRpcNotification = { method: "unknown/whatever", params: {} };
    const events = codexNotificationToEvents(n, projectId);
    expect(events).toHaveLength(0);
  });

  it("normalizes item/started to timeline.item.started", () => {
    const n: JsonRpcNotification = {
      method: "item/started",
      params: {
        threadId: "th-1",
        turnId: "t-1",
        item: { id: "i-1", type: "commandExecution", command: "ls" },
      },
    };
    const events = codexNotificationToEvents(n, projectId);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.type).toBe("timeline.item.started");
    if (e.type === "timeline.item.started") {
      expect(e.itemId).toBe("i-1");
    }
  });
});

describe("codexServerRequestToEvent (approval routing)", () => {
  it("normalizes item/commandExecution/requestApproval to approval.requested (command_execution)", () => {
    const r: JsonRpcServerRequest = {
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "th-1",
        turnId: "t-1",
        itemId: "i-1",
        command: ["ls", "-la"],
        // Codex から来る availableDecisions は camelCase. normalizer が
        // accept_for_session (snake) に変換するか確認.
        availableDecisions: ["accept", "acceptForSession", "decline"],
      },
    };
    const e = codexServerRequestToEvent(r);
    expect(e).not.toBeNull();
    if (e !== null && e.type === "approval.requested") {
      expect(e.request.kind).toBe("command_execution");
      expect(e.request.threadId).toBe("th-1");
      expect(e.request.id).toBe("42");
      expect(e.request.availableDecisions).toContain("accept_for_session");
    }
  });

  it("normalizes item/fileChange/requestApproval to approval.requested (file_change)", () => {
    const r: JsonRpcServerRequest = {
      id: "abc",
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "th-1",
        turnId: "t-1",
        itemId: "i-2",
      },
    };
    const e = codexServerRequestToEvent(r);
    expect(e).not.toBeNull();
    if (e !== null && e.type === "approval.requested") {
      expect(e.request.kind).toBe("file_change");
    }
  });

  it("returns null for unknown server request method", () => {
    const r: JsonRpcServerRequest = {
      id: 1,
      method: "unknown/req",
      params: {},
    };
    expect(codexServerRequestToEvent(r)).toBeNull();
  });
});
