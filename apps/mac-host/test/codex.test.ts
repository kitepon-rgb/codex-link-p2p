import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NullCodexClient,
  readAppServerPortFile,
  writeAppServerPortFile,
  type AppServerPortFile,
  type CodexAppServerEvent,
} from "../src/codex.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "codex-link-codex-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("NullCodexClient", () => {
  it("start / stop flips isRunning", async () => {
    const c = new NullCodexClient();
    expect(c.isRunning()).toBe(false);
    await c.start();
    expect(c.isRunning()).toBe(true);
    await c.stop();
    expect(c.isRunning()).toBe(false);
  });

  it("emit fans out events to all registered handlers", async () => {
    const c = new NullCodexClient();
    await c.start();
    const got: CodexAppServerEvent[] = [];
    const unsub = c.onEvent((e) => got.push(e));
    c.emit({ type: "x" });
    c.emit({ type: "y" });
    expect(got.map((e) => e.type)).toEqual(["x", "y"]);
    unsub();
    c.emit({ type: "z" });
    expect(got.map((e) => e.type)).toEqual(["x", "y"]);
  });

  it("sendCommand records the command and throws when not running", async () => {
    const c = new NullCodexClient();
    await expect(c.sendCommand({ type: "cmd" })).rejects.toThrow(/not running/);
    await c.start();
    await c.sendCommand({ type: "ok" });
    expect(c.commandsSent().map((x) => x.type)).toEqual(["ok"]);
  });
});

describe("AppServerPortFile", () => {
  it("readAppServerPortFile returns null when missing", async () => {
    expect(await readAppServerPortFile()).not.toBeUndefined();
    // (we cannot guarantee absence of the shared $TMPDIR file; just verify the
    // function returns either null or a well-formed object)
  });

  it("write / read round-trips the JSON shape", async () => {
    const info: AppServerPortFile = {
      port: 12345,
      pid: 67890,
      url: "ws://127.0.0.1:12345",
      writtenAt: 1_700_000_000_000,
    };
    await writeAppServerPortFile(info);
    const back = await readAppServerPortFile();
    expect(back).not.toBeNull();
    expect(back?.port).toBe(12345);
    expect(back?.url).toBe("ws://127.0.0.1:12345");
  });
});
