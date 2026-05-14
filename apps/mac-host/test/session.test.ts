// SessionManager: Codex notification ↔ DataChannel frame の双方向 routing と
// projection 維持を、NullCodexClient 経由で検証する.

import { beforeEach, describe, expect, it } from "vitest";

import {
  asDeviceId,
  asHostId,
  asUserId,
  type DeviceId,
  type UserId,
} from "@codex-link/protocol/rendezvous";
import {
  asProjectId,
  asRequestId,
  asThreadId,
  asTurnId,
  type CodexLinkSessionFrame,
  type HostCapabilities,
} from "@codex-link/protocol/session";

import { NullCodexClient } from "../src/codex.js";
import { SessionManager, type PeerSink } from "../src/session.js";

const hostId = asHostId("hst_test");
const projectId = asProjectId("test-proj");
const userId = asUserId("usr_phone");
const deviceId = asDeviceId("dev_phone");

class CapturingSink implements PeerSink {
  sent: Array<{
    target: "broadcast" | { userId: UserId; deviceId: DeviceId };
    frame: CodexLinkSessionFrame;
  }> = [];

  sendFrame(
    key: { userId: UserId; deviceId: DeviceId },
    frame: CodexLinkSessionFrame,
  ): boolean {
    this.sent.push({ target: key, frame });
    return true;
  }
  broadcastFrame(frame: CodexLinkSessionFrame): number {
    this.sent.push({ target: "broadcast", frame });
    return 1;
  }
}

const capabilities: HostCapabilities = {
  hostId,
  platform: "macos",
  codexVersion: "0.0.0-test",
  supportsApprovals: true,
};

let codex: NullCodexClient;
let sink: CapturingSink;
let session: SessionManager;

beforeEach(() => {
  sink = new CapturingSink();
  codex = new NullCodexClient({
    onNotification: (n) => session.handleCodexNotification(n),
    onServerRequest: (r) => session.handleCodexServerRequest(r),
  });
  session = new SessionManager({
    hostId,
    hostCapabilities: capabilities,
    codex,
    peers: sink,
    now: () => 1_700_000_000_000,
    defaultProjectId: projectId,
  });
});

describe("SessionManager: codex → peers", () => {
  it("broadcasts normalized assistant.delta event as a session frame", () => {
    codex.emitNotification({
      method: "thread/started",
      params: { thread: { id: "t1", name: "Hi" } },
    });
    codex.emitNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "t1", turnId: "tn1", delta: "hello" },
    });
    const eventFrames = sink.sent.filter((s) => s.frame.kind === "event");
    expect(eventFrames.length).toBe(2);
    expect(eventFrames[1]?.target).toBe("broadcast");
  });

  it("drops unknown codex notifications (no frame broadcasted)", () => {
    codex.emitNotification({ method: "totally.unknown.thing", params: {} });
    expect(sink.sent.length).toBe(0);
  });

  it("maintains projection state across notifications", () => {
    codex.emitNotification({
      method: "thread/started",
      params: { thread: { id: "t1", name: "Hi" } },
    });
    codex.emitNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "t1", turnId: "tn1", delta: "hi back" },
    });
    const proj = session.currentProjection();
    expect(proj.threads.length).toBe(1);
    expect(proj.threads[0]?.thread.title).toBe("Hi");
    expect(proj.threads[0]?.streamingAssistant).toBe("hi back");
  });

  it("tracks pendingApproval until approval.resolved (server request → ui.respond)", async () => {
    codex.emitNotification({
      method: "thread/started",
      params: { thread: { id: "t1", name: "Hi" } },
    });
    codex.emitNotification({
      method: "turn/started",
      params: { threadId: "t1", turn: { id: "tn1", status: "running" } },
    });
    codex.emitServerRequest({
      id: "rq1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "t1",
        turnId: "tn1",
        itemId: "i1",
        command: ["rm", "-rf", "/tmp/junk"],
      },
    });
    let proj = session.currentProjection();
    expect(proj.threads[0]?.pendingApproval?.id).toBe("rq1");

    session.handlePeerFrame(
      { userId, deviceId },
      {
        kind: "ui_action",
        action: {
          type: "ui.respond_approval",
          decision: { requestId: asRequestId("rq1"), decision: "decline" },
        },
      },
    );
    await new Promise((r) => setTimeout(r, 0));
    proj = session.currentProjection();
    expect(proj.threads[0]?.pendingApproval).toBeNull();
  });
});

describe("SessionManager: peer → codex", () => {
  it("ui.submit_turn with threadId → codex turn/start request with prompt", async () => {
    await session.handlePeerFrame(
      { userId, deviceId },
      {
        kind: "ui_action",
        action: {
          type: "ui.submit_turn",
          projectId,
          threadId: asThreadId("t1"),
          input: "do the thing",
        },
      },
    );
    await new Promise((r) => setTimeout(r, 0));
    const reqs = codex.sentRequests();
    expect(reqs.find((r) => r.method === "turn/start")).toBeDefined();
    const turnReq = reqs.find((r) => r.method === "turn/start");
    expect((turnReq?.params as Record<string, unknown>)?.["prompt"]).toBe("do the thing");
  });

  it("ui.submit_turn with threadId=null → codex thread/start with prompt", async () => {
    await session.handlePeerFrame(
      { userId, deviceId },
      {
        kind: "ui_action",
        action: {
          type: "ui.submit_turn",
          projectId,
          threadId: null,
          input: "new thread please",
        },
      },
    );
    await new Promise((r) => setTimeout(r, 0));
    const reqs = codex.sentRequests();
    expect(reqs.find((r) => r.method === "thread/start")).toBeDefined();
  });

  it("ui.cancel_turn → codex turn/interrupt", async () => {
    await session.handlePeerFrame(
      { userId, deviceId },
      {
        kind: "ui_action",
        action: {
          type: "ui.cancel_turn",
          threadId: asThreadId("t1"),
          turnId: asTurnId("tn1"),
        },
      },
    );
    await new Promise((r) => setTimeout(r, 0));
    const reqs = codex.sentRequests();
    expect(reqs.find((r) => r.method === "turn/interrupt")).toBeDefined();
  });

  it("snapshot_request → sendFrame snapshot_response to the requesting peer", () => {
    session.handlePeerFrame(
      { userId, deviceId },
      {
        kind: "snapshot_request",
        request: {
          fromUserId: userId,
          fromDeviceId: deviceId,
          hostId,
          lastSequence: null,
        },
      },
    );
    const snapshot = sink.sent.find((s) => s.frame.kind === "snapshot_response");
    expect(snapshot).toBeDefined();
    expect(snapshot?.target).toEqual({ userId, deviceId });
  });
});
