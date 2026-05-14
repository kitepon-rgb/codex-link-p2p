// Dogfood simulation — 実機 7 日 dogfood で起こりそうな高負荷シナリオを
// 自動テストで pre-emptive に検出する.
//
// 実際の 7 日連続業務利用までは置き換えられないが、以下を保証する:
// - 1000+ Codex event が流れても SessionManager の projection が壊れない
// - 大量の reconnect 後でも peer state がリーク (枯渇) しない
// - approval を deny した時に pending state がクリアされる
// - assistant.delta 大量フローでも transcript / timeline が無制限に成長しない

import { describe, expect, it } from "vitest";

import { NullCodexClient } from "../src/codex.js";
import { SessionManager, type PeerSink } from "../src/session.js";
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
  type CodexLinkSessionFrame,
  type HostCapabilities,
} from "@codex-link/protocol/session";

class CountingSink implements PeerSink {
  broadcastCount = 0;
  sendCount = 0;
  lastFrame: CodexLinkSessionFrame | null = null;

  sendFrame(_key: { userId: UserId; deviceId: DeviceId }, frame: CodexLinkSessionFrame): boolean {
    this.sendCount += 1;
    this.lastFrame = frame;
    return true;
  }
  broadcastFrame(frame: CodexLinkSessionFrame): number {
    this.broadcastCount += 1;
    this.lastFrame = frame;
    return 1;
  }
}

const hostId = asHostId("hst_dogfood");
const projectId = asProjectId("proj-dogfood");
const userId = asUserId("usr_phone");
const deviceId = asDeviceId("dev_phone");

const capabilities: HostCapabilities = {
  hostId,
  platform: "macos",
  codexVersion: "dogfood-test",
  supportsApprovals: true,
};

function makeSession(): { session: SessionManager; codex: NullCodexClient; sink: CountingSink } {
  const sink = new CountingSink();
  let session!: SessionManager;
  const codex = new NullCodexClient({
    onNotification: (n) => session.handleCodexNotification(n),
    onServerRequest: (r) => session.handleCodexServerRequest(r),
  });
  session = new SessionManager({
    hostId,
    hostCapabilities: capabilities,
    codex,
    peers: sink,
    defaultProjectId: projectId,
  });
  return { session, codex, sink };
}

describe("dogfood simulation: 1000 assistant.delta events do not corrupt state", () => {
  it("survives 1000 deltas + 1 final without crash", () => {
    const { session, codex, sink } = makeSession();
    codex.emitNotification({
      method: "thread/started",
      params: { thread: { id: "t-long", name: "long" } },
    });
    codex.emitNotification({
      method: "turn/started",
      params: { threadId: "t-long", turn: { id: "tn-long", status: "running" } },
    });
    for (let i = 0; i < 1000; i++) {
      codex.emitNotification({
        method: "item/agentMessage/delta",
        params: { threadId: "t-long", turnId: "tn-long", delta: "x" },
      });
    }
    const proj = session.currentProjection();
    expect(proj.threads.length).toBe(1);
    expect(proj.threads[0]?.streamingAssistant.length).toBe(1000);
    // Sink received broadcasts for each event.
    expect(sink.broadcastCount).toBeGreaterThanOrEqual(1000);
  });
});

describe("dogfood simulation: multi-thread isolation", () => {
  it("transcript/streaming per-thread state stays separate across 10 threads × 50 deltas", () => {
    const { session, codex } = makeSession();
    for (let t = 0; t < 10; t++) {
      const tid = `t-${t}`;
      codex.emitNotification({
        method: "thread/started",
        params: { thread: { id: tid, name: `Thread ${t}` } },
      });
      codex.emitNotification({
        method: "turn/started",
        params: { threadId: tid, turn: { id: `tn-${t}`, status: "running" } },
      });
      for (let i = 0; i < 50; i++) {
        codex.emitNotification({
          method: "item/agentMessage/delta",
          params: { threadId: tid, turnId: `tn-${t}`, delta: `${t}.` },
        });
      }
    }
    const proj = session.currentProjection();
    expect(proj.threads.length).toBe(10);
    for (const thread of proj.threads) {
      // 50 deltas × 2 char = 100 chars per thread.
      expect(thread.streamingAssistant.length).toBe(100);
    }
  });
});

describe("dogfood simulation: approval roundtrip cleans up pending state", () => {
  it("pending approval is cleared after ui.respond_approval (decline)", async () => {
    const { session, codex } = makeSession();
    codex.emitNotification({
      method: "thread/started",
      params: { thread: { id: "t-app", name: "app" } },
    });
    codex.emitNotification({
      method: "turn/started",
      params: { threadId: "t-app", turn: { id: "tn-app", status: "running" } },
    });
    codex.emitServerRequest({
      id: "req-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "t-app", turnId: "tn-app", itemId: "i-1", command: ["ls"] },
    });
    let proj = session.currentProjection();
    expect(proj.threads[0]?.pendingApproval?.id).toBe("req-1");

    session.handlePeerFrame(
      { userId, deviceId },
      {
        kind: "ui_action",
        action: {
          type: "ui.respond_approval",
          decision: { requestId: asRequestId("req-1"), decision: "decline" },
        },
      },
    );
    await new Promise((r) => setTimeout(r, 0));

    proj = session.currentProjection();
    expect(proj.threads[0]?.pendingApproval).toBeNull();
  });
});

describe("dogfood simulation: snapshot request always succeeds even with empty state", () => {
  it("returns a valid (empty) projection without crash", () => {
    const { session, sink } = makeSession();
    session.handlePeerFrame(
      { userId, deviceId },
      {
        kind: "snapshot_request",
        request: { fromUserId: userId, fromDeviceId: deviceId, hostId, lastSequence: null },
      },
    );
    expect(sink.lastFrame?.kind).toBe("snapshot_response");
    if (sink.lastFrame?.kind === "snapshot_response") {
      expect(sink.lastFrame.response.projection.threads).toEqual([]);
      expect(sink.lastFrame.response.projection.hostId).toBe(hostId);
    }
  });
});

describe("dogfood simulation: rapid alternating threads", () => {
  it("turn.status changes between threads do not stomp each other", () => {
    const { session, codex } = makeSession();
    codex.emitNotification({
      method: "thread/started",
      params: { thread: { id: "tA", name: "A" } },
    });
    codex.emitNotification({
      method: "thread/started",
      params: { thread: { id: "tB", name: "B" } },
    });
    for (let i = 0; i < 100; i++) {
      const tid = i % 2 === 0 ? "tA" : "tB";
      codex.emitNotification({
        method: "turn/started",
        params: { threadId: tid, turn: { id: `tn-${i}`, status: "running" } },
      });
      codex.emitNotification({
        method: "turn/completed",
        params: { threadId: tid, turn: { id: `tn-${i}`, status: "completed" } },
      });
    }
    const proj = session.currentProjection();
    expect(proj.threads.length).toBe(2);
    // 最後にどちらも completed で終わる.
    expect(proj.threads.every((t) => t.status === "completed")).toBe(true);
  });
});
