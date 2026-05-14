// Codex app-server client (thin re-export + spawn helper).
//
// 親リポと同じ design: `codex app-server --listen ws://127.0.0.1:0` を起動して
// WebSocket JSON-RPC で話す. Mac Host は `@codex-link/codex-client` の
// `CodexAppServerClient` (= JSON-RPC 2.0 client) をそのまま使う.
//
// このファイルでは spawn + listen 取得 + WS connect を一発で行う helper を
// 提供する. NullCodexClient (test stub) も用意してオフライン test を可能にする.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import {
  createCodexAppServerWebSocketClient,
  type CodexAppServerClient,
  type CodexAppServerWebSocketClientOptions,
  type JsonRpcNotification,
  type JsonRpcServerRequest,
} from "@codex-link/codex-client";

// ===== Real Codex: spawn + connect =====

export interface StartCodexOptions {
  readonly codexCommand?: string; // default: "codex"
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
  readonly clientInfo?: { name: string; title: string; version: string };
  readonly experimentalApi?: boolean;
  readonly startupTimeoutMs?: number;
  readonly onNotification?: (n: JsonRpcNotification) => void;
  readonly onServerRequest?: (r: JsonRpcServerRequest) => void;
}

export interface StartedCodex {
  readonly client: CodexAppServerClient;
  readonly port: number;
  readonly url: string;
  readonly childProcess: ChildProcessWithoutNullStreams;
}

/**
 * `codex app-server --listen ws://127.0.0.1:0` を spawn し、stderr の listen
 * banner から port を拾って WebSocket client を確立する.
 */
export const startCodex = async (
  opts: StartCodexOptions = {},
): Promise<StartedCodex> => {
  const child = spawn(
    opts.codexCommand ?? "codex",
    ["app-server", "--listen", "ws://127.0.0.1:0"],
    {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const stderrLines = createInterface({ input: child.stderr });
  const port = await new Promise<number>((resolve, reject) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (resolved) return;
      reject(new Error(`Timed out waiting for codex app-server WS banner (${opts.startupTimeoutMs ?? 10_000}ms)`));
    }, opts.startupTimeoutMs ?? 10_000);
    timeout.unref?.();
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onLine = (line: string): void => {
      if (resolved) return;
      const match = /ws:\/\/127\.0\.0\.1:(\d+)/.exec(line);
      if (match && match[1]) {
        resolved = true;
        cleanup();
        resolve(Number.parseInt(match[1], 10));
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      if (!resolved) {
        reject(new Error(`codex app-server exited before listening (code=${code}, signal=${signal})`));
      }
    };
    const onError = (e: Error): void => {
      cleanup();
      if (!resolved) reject(e);
    };
    stderrLines.on("line", onLine);
    child.once("exit", onExit);
    child.once("error", onError);
  });

  const url = `ws://127.0.0.1:${port}`;
  const wsOptions: CodexAppServerWebSocketClientOptions = {
    url,
    clientInfo: opts.clientInfo ?? {
      name: "codex_link_mac_host",
      title: "Codex Link Mac Host (p2p)",
      version: "0.1.0",
    },
    experimentalApi: opts.experimentalApi ?? true,
    ...(opts.onNotification ? { onNotification: opts.onNotification } : {}),
    ...(opts.onServerRequest ? { onServerRequest: opts.onServerRequest } : {}),
  };
  const client = await createCodexAppServerWebSocketClient(wsOptions);
  await client.initialize();
  return { client, port, url, childProcess: child };
};

// ===== Test stub: NullCodexClient =====
//
// `CodexAppServerClient` インタフェースを満たすが、実際の codex プロセスは
// spawn しない. テストや Codex 未インストール環境で SessionManager 周辺を
// 触る時に使う.

import type {
  CodexAppServerClientOptions,
  JsonRpcId,
} from "@codex-link/codex-client";

export class NullCodexClient implements CodexAppServerClient {
  private readonly requests: Array<{ method: string; params?: unknown }> = [];
  private readonly notifications: Array<{ method: string; params?: unknown }> = [];
  private readonly handlers: {
    notification?: (n: JsonRpcNotification) => void;
    serverRequest?: (r: JsonRpcServerRequest) => void;
  } = {};
  private nextResponseId = 1;

  constructor(opts: { onNotification?: (n: JsonRpcNotification) => void; onServerRequest?: (r: JsonRpcServerRequest) => void } = {}) {
    if (opts.onNotification) this.handlers.notification = opts.onNotification;
    if (opts.onServerRequest) this.handlers.serverRequest = opts.onServerRequest;
  }

  async start(): Promise<void> {
    /* noop */
  }
  async initialize(): Promise<unknown> {
    return { ok: true };
  }
  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    return { id: `req_${this.nextResponseId++}` };
  }
  startThread(params: unknown): Promise<unknown> { return this.request("thread/start", params); }
  resumeThread(params: unknown): Promise<unknown> { return this.request("thread/resume", params); }
  startTurn(params: unknown): Promise<unknown> { return this.request("turn/start", params); }
  steerTurn(params: unknown): Promise<unknown> { return this.request("turn/steer", params); }
  interruptTurn(params: unknown): Promise<unknown> { return this.request("turn/interrupt", params); }
  listModels(params?: unknown): Promise<unknown> { return this.request("model/list", params); }
  listExperimentalFeatures(params?: unknown): Promise<unknown> { return this.request("experimentalFeature/list", params); }
  readConfig(params: unknown): Promise<unknown> { return this.request("config/read", params); }
  listThreads(params?: unknown): Promise<unknown> { return this.request("thread/list", params); }
  readThread(params: unknown): Promise<unknown> { return this.request("thread/read", params); }
  listThreadTurns(params: unknown): Promise<unknown> { return this.request("thread/turns/list", params); }
  respondToServerRequest(_id: JsonRpcId, _result: unknown): void {
    /* noop */
  }
  notify(method: string, params?: unknown): void {
    this.notifications.push({ method, params });
  }
  async close(): Promise<void> {
    /* noop */
  }

  // ===== Test API =====

  /** Inject a notification as if it came from Codex. */
  emitNotification(message: JsonRpcNotification): void {
    this.handlers.notification?.(message);
  }
  /** Inject a server request as if it came from Codex. */
  emitServerRequest(message: JsonRpcServerRequest): void {
    this.handlers.serverRequest?.(message);
  }
  sentRequests(): readonly { method: string; params?: unknown }[] {
    return this.requests;
  }
  sentNotifications(): readonly { method: string; params?: unknown }[] {
    return this.notifications;
  }
}

// ===== Re-export option types so cli / tests can type their callbacks =====

export type { CodexAppServerClient, CodexAppServerClientOptions, JsonRpcNotification, JsonRpcServerRequest };

// ===== ResilientCodexClient =====
//
// `startCodex()` で spawn した codex app-server プロセスが落ちた時に自動で
// 再 spawn + WS 再接続する wrapper. 7 日 dogfood で codex が一度でも crash
// したら手動再起動が必要、という痛みを解消する.
//
// 設計:
// - inner client (生 CodexAppServerWebSocketClient) を保持し、すべての method
//   をその時の inner にフォワードする.
// - child process の exit を listen し、graceful なら止める. 異常終了なら
//   指数バックオフで再 spawn.
// - 再 spawn 中の request は queue する (現状は throw する単純設計; 必要なら
//   queue 化).

export interface ResilientCodexOptions extends StartCodexOptions {
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly onRespawn?: (info: { attempt: number; reason: string; port: number | null }) => void;
}

export class ResilientCodexClient implements CodexAppServerClient {
  private inner: CodexAppServerClient | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private respawnAttempts = 0;
  private stopped = false;
  private readonly options: ResilientCodexOptions;

  constructor(options: ResilientCodexOptions = {}) {
    this.options = options;
  }

  /**
   * 初回 spawn. 失敗したら throw (= Mac Host 起動失敗). 起動後の crash は
   * resilient に再 spawn する.
   */
  async start(): Promise<void> {
    await this.spawnOnce();
  }

  private async spawnOnce(): Promise<void> {
    const opts: StartCodexOptions = {
      ...this.options,
      onNotification: (n) => this.options.onNotification?.(n),
      onServerRequest: (r) => this.options.onServerRequest?.(r),
    };
    const started = await startCodex(opts);
    this.inner = started.client;
    this.child = started.childProcess;
    this.respawnAttempts = 0;

    // crash 検出.
    const handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (this.stopped) return;
      this.inner = null;
      this.child = null;
      this.scheduleRespawn(`codex exited code=${code} signal=${signal}`);
    };
    started.childProcess.once("exit", handleExit);
  }

  private scheduleRespawn(reason: string): void {
    if (this.stopped) return;
    this.respawnAttempts += 1;
    const base = this.options.minBackoffMs ?? 500;
    const max = this.options.maxBackoffMs ?? 30_000;
    const wait = Math.min(base * Math.pow(2, this.respawnAttempts - 1), max);
    setTimeout(() => {
      if (this.stopped) return;
      this.spawnOnce().then(
        () => {
          this.options.onRespawn?.({
            attempt: this.respawnAttempts,
            reason,
            port: null,
          });
        },
        () => {
          // 失敗したら再 schedule.
          this.scheduleRespawn(`respawn-failed-after:${reason}`);
        },
      );
    }, wait).unref?.();
  }

  // ===== CodexAppServerClient delegation =====

  async initialize(): Promise<unknown> {
    return this.requireInner().initialize();
  }
  request(method: string, params?: unknown): Promise<unknown> {
    return this.requireInner().request(method, params);
  }
  startThread(params: unknown): Promise<unknown> { return this.requireInner().startThread(params); }
  resumeThread(params: unknown): Promise<unknown> { return this.requireInner().resumeThread(params); }
  startTurn(params: unknown): Promise<unknown> { return this.requireInner().startTurn(params); }
  steerTurn(params: unknown): Promise<unknown> { return this.requireInner().steerTurn(params); }
  interruptTurn(params: unknown): Promise<unknown> { return this.requireInner().interruptTurn(params); }
  listModels(params?: unknown): Promise<unknown> { return this.requireInner().listModels(params); }
  listExperimentalFeatures(params?: unknown): Promise<unknown> { return this.requireInner().listExperimentalFeatures(params); }
  readConfig(params: unknown): Promise<unknown> { return this.requireInner().readConfig(params); }
  listThreads(params?: unknown): Promise<unknown> { return this.requireInner().listThreads(params); }
  readThread(params: unknown): Promise<unknown> { return this.requireInner().readThread(params); }
  listThreadTurns(params: unknown): Promise<unknown> { return this.requireInner().listThreadTurns(params); }
  respondToServerRequest(id: JsonRpcId, result: unknown): void {
    this.requireInner().respondToServerRequest(id, result);
  }
  notify(method: string, params?: unknown): void {
    this.requireInner().notify(method, params);
  }
  async close(): Promise<void> {
    this.stopped = true;
    try {
      await this.inner?.close();
    } catch {
      /* ignore */
    }
    try {
      this.child?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    this.inner = null;
    this.child = null;
  }

  isRunning(): boolean {
    return this.inner !== null && !this.stopped;
  }

  private requireInner(): CodexAppServerClient {
    if (this.inner === null) {
      throw new Error("codex app-server is not currently connected (respawning?)");
    }
    return this.inner;
  }
}
