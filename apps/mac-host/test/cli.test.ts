// `runInit` / `runStart` の integration テスト. 実 Relay を立てて、
// CLI 関数を直接呼び出して flow 全体を駆動する.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createRelayServer,
  createRelayState,
  loadConfig,
  startRelayServer,
  type StartedServer,
} from "@codex-link/relay";

import { runInit, runStart, type StartedHost } from "../src/cli.js";
import { NullCodexClient } from "../src/codex.js";

const BOOTSTRAP = "test-bootstrap-cli";
const env = {
  TURN_SHARED_SECRET: "test-turn-cli",
  CODEX_LINK_HOST_BOOTSTRAP_TOKEN: BOOTSTRAP,
};

let started: StartedServer;
let baseUrl: string;
let home: string;
let cliEnv: Record<string, string | undefined>;

beforeEach(async () => {
  const state = createRelayState();
  const config = loadConfig({ env });
  const created = createRelayServer({
    state,
    config,
    now: () => Date.now(),
  });
  started = await startRelayServer(created, "127.0.0.1", 0);
  baseUrl = `http://127.0.0.1:${started.port}`;
  home = await mkdtemp(join(tmpdir(), "codex-link-cli-"));
  cliEnv = {
    CODEX_LINK_HOME: home,
    CODEX_LINK_RELAY_URL: baseUrl,
    CODEX_LINK_TOKEN_STORE: "file",
  };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await started.close();
});

describe("runInit", () => {
  it("writes host.json and stores token in the file store", async () => {
    await runInit({
      relayUrl: baseUrl,
      bootstrapToken: BOOTSTRAP,
      displayName: "test Mac",
      hostPlatform: "linux", // CI 互換のため
      env: cliEnv,
    });
    const cfg = JSON.parse(
      await readFile(join(home, "host.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(typeof cfg["userId"]).toBe("string");
    expect(typeof cfg["deviceId"]).toBe("string");
    expect(typeof cfg["hostId"]).toBe("string");
    expect(cfg["displayName"]).toBe("test Mac");
    expect(cfg["hostPlatform"]).toBe("linux");
    expect(cfg["relayUrl"]).toBe(baseUrl);

    // token は host.json に入っていない. file token store にあるはず.
    const fs = await import("node:fs/promises");
    const tokFile = join(
      home,
      "tokens",
      `${cfg["userId"] as string}:${cfg["deviceId"] as string}.token`,
    );
    const tokRaw = await fs.readFile(tokFile, "utf8");
    expect(tokRaw.trim().length).toBeGreaterThan(20);
  });

  it("rejects bad bootstrap token with an HTTP error", async () => {
    await expect(
      runInit({
        relayUrl: baseUrl,
        bootstrapToken: "wrong",
        displayName: "x",
        hostPlatform: "linux",
        env: cliEnv,
      }),
    ).rejects.toThrow(/HTTP 401/);
  });
});

describe("runStart", () => {
  it("connects to relay, announces, and surfaces signaling_welcome", async () => {
    await runInit({
      relayUrl: baseUrl,
      bootstrapToken: BOOTSTRAP,
      displayName: "test Mac",
      hostPlatform: "linux",
      env: cliEnv,
    });

    const codex = new NullCodexClient();
    let host: StartedHost | null = null;
    try {
      host = await runStart({
        env: cliEnv,
        codexClient: codex,
        turnUrls: ["stun:stun.l.google.com:19302"],
      });
      // signaling state が open になるのを待つ.
      await waitFor(() => host?.signaling.currentState() === "open", 2_000);
      expect(host.signaling.currentState()).toBe("open");
    } finally {
      await host?.stop();
    }
  });

  it("fails when no token in store (init not run)", async () => {
    // host.json は無い状態.
    await expect(
      runStart({ env: cliEnv, codexClient: new NullCodexClient() }),
    ).rejects.toThrow(/host\.json not found/);
  });
});

const waitFor = (cond: () => boolean, timeoutMs = 1_000): Promise<void> =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (cond()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitFor timed out (${timeoutMs}ms)`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
