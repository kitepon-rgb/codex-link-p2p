import { beforeEach, describe, expect, it } from "vitest";

import {
  asDeviceId,
  asHostId,
  asUserId,
  type DeviceId,
  type UserId,
} from "@codex-link/protocol/rendezvous";
import {
  asRequestId,
  asThreadId,
  type CodexLinkSessionFrame,
  type HostCapabilities,
} from "@codex-link/protocol/session";

import { NullCodexClient } from "../src/codex.js";
import { SessionManager, type PeerSink } from "../src/session.js";

const hostId = asHostId("hst_test");
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
  codex = new NullCodexClient();
  void codex.start();
  sink = new CapturingSink();
  session = new SessionManager({
    hostId,
    hostCapabilities: capabilities,
    codex,
    peers: sink,
    now: () => 1_700_000_000_000,
  });
  session.start();
});

describe("SessionManager: codex → peers", () => {
  it("broadcasts normalized assistant.delta event as a session frame", () => {
    codex.emit({
      type: "thread_started",
      threadId: "t1",
      data: { projectId: "p", title: "Hi" },
    });
    codex.emit({
      type: "assistant_message_delta",
      threadId: "t1",
      data: { delta: "hello" },
    });

    const eventFrames = sink.sent.filter(
      (s) => s.frame.kind === "event",
    );
    expect(eventFrames.length).toBe(2);
    expect(eventFrames[1]?.target).toBe("broadcast");
  });

  it("drops unknown codex events (no frame broadcasted)", () => {
    codex.emit({ type: "totally.unknown.thing" });
    expect(sink.sent.length).toBe(0);
  });

  it("maintains projection state across events", () => {
    codex.emit({
      type: "thread_started",
      threadId: "t1",
      data: { projectId: "p", title: "Hi" },
    });
    codex.emit({
      type: "transcript_item_recorded",
      threadId: "t1",
      data: { role: "user", content: "hello" },
    });
    codex.emit({
      type: "assistant_message",
      threadId: "t1",
      data: { text: "hi back" },
    });
    codex.emit({
      type: "timeline_item_started",
      threadId: "t1",
      id: "tool1",
      data: { kind: "tool_call", label: "shell" },
    });
    codex.emit({
      type: "timeline_item_completed",
      threadId: "t1",
      id: "tool1",
      data: { outcome: "success" },
    });

    const proj = session.currentProjection();
    expect(proj.threads.length).toBe(1);
    const t = proj.threads[0];
    expect(t?.title).toBe("Hi");
    expect(t?.transcript.map((x) => x.role)).toEqual(["user", "assistant"]);
    expect(t?.timeline[0]?.outcome).toBe("success");
  });

  it("tracks pendingApproval until approval.resolved", () => {
    codex.emit({
      type: "thread_started",
      threadId: "t1",
      data: { projectId: "p", title: "Hi" },
    });
    codex.emit({
      type: "approval_request",
      threadId: "t1",
      id: "r1",
      data: { summary: "rm -rf", kind: "command", detail: "danger" },
    });
    let proj = session.currentProjection();
    expect(proj.threads[0]?.pendingApproval?.requestId).toBe("r1");

    codex.emit({
      type: "approval_resolved",
      threadId: "t1",
      data: { requestId: "r1", approved: false },
    });
    proj = session.currentProjection();
    expect(proj.threads[0]?.pendingApproval).toBeNull();
  });
});

describe("SessionManager: peer → codex", () => {
  it("ui.submit_turn → codex command 'user_turn' with input", async () => {
    await session.handlePeerFrame(
      { userId, deviceId },
      {
        kind: "ui_action",
        action: {
          type: "ui.submit_turn",
          threadId: asThreadId("t1"),
          input: "do the thing",
        },
      },
    );
    // 同期で sendCommand が呼ばれている.
    const cmds = codex.commandsSent();
    expect(cmds.length).toBe(1);
    expect(cmds[0]?.type).toBe("user_turn");
    expect((cmds[0]?.data as Record<string, unknown> | undefined)?.["input"]).toBe(
      "do the thing",
    );
  });

  it("ui.respond_approval → codex approval_response", async () => {
    session.handlePeerFrame(
      { userId, deviceId },
      {
        kind: "ui_action",
        action: {
          type: "ui.respond_approval",
          decision: {
            requestId: asRequestId("r1"),
            approved: true,
            reason: "ok",
          },
        },
      },
    );
    // microtask flush.
    await new Promise((r) => setTimeout(r, 0));
    const cmds = codex.commandsSent();
    expect(cmds.find((c) => c.type === "approval_response")).toBeDefined();
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
    const snapshot = sink.sent.find(
      (s) => s.frame.kind === "snapshot_response",
    );
    expect(snapshot).toBeDefined();
    expect(snapshot?.target).toEqual({ userId, deviceId });
  });

  it("error.reported when codex command fails", async () => {
    const failingCodex = new NullCodexClient();
    await failingCodex.start();
    // monkey-patch to throw.
    failingCodex.sendCommand = async () => {
      throw new Error("codex offline");
    };
    const session2 = new SessionManager({
      hostId,
      hostCapabilities: capabilities,
      codex: failingCodex,
      peers: sink,
      now: () => 1,
    });
    session2.start();
    sink.sent = [];

    session2.handlePeerFrame(
      { userId, deviceId },
      {
        kind: "ui_action",
        action: {
          type: "ui.submit_turn",
          threadId: asThreadId("t1"),
          input: "x",
        },
      },
    );
    await new Promise((r) => setTimeout(r, 0));
    const err = sink.sent.find(
      (s) => s.frame.kind === "event" && s.frame.event.type === "error.reported",
    );
    expect(err).toBeDefined();
  });
});
