// NullCodexClient (test stub) の挙動を検証.
// 実 Codex spawn は別途 dogfood で確認 (vitest で codex CLI を依存させない).

import { describe, expect, it } from "vitest";

import { NullCodexClient } from "../src/codex.js";
import type { JsonRpcNotification, JsonRpcServerRequest } from "@codex-link/codex-client";

describe("NullCodexClient", () => {
  it("forwards a notification injected via emitNotification to onNotification handler", () => {
    const got: JsonRpcNotification[] = [];
    const c = new NullCodexClient({ onNotification: (n) => got.push(n) });
    const sample: JsonRpcNotification = { method: "thread/started", params: { thread: { id: "th-1" } } };
    c.emitNotification(sample);
    expect(got).toHaveLength(1);
    expect(got[0]?.method).toBe("thread/started");
  });

  it("forwards a server request injected via emitServerRequest to onServerRequest handler", () => {
    const got: JsonRpcServerRequest[] = [];
    const c = new NullCodexClient({ onServerRequest: (r) => got.push(r) });
    const sample: JsonRpcServerRequest = {
      id: 1,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "th-1", turnId: "t-1" },
    };
    c.emitServerRequest(sample);
    expect(got).toHaveLength(1);
    expect(got[0]?.method).toBe("item/commandExecution/requestApproval");
  });

  it("records requests sent via startTurn / startThread", async () => {
    const c = new NullCodexClient();
    await c.startThread({ projectId: "p", prompt: "hi" });
    await c.startTurn({ threadId: "th-1", prompt: "next" });
    const sent = c.sentRequests();
    expect(sent).toHaveLength(2);
    expect(sent[0]?.method).toBe("thread/start");
    expect(sent[1]?.method).toBe("turn/start");
  });
});
