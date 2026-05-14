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
