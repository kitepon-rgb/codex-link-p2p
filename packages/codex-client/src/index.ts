import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { WebSocket, type RawData } from "ws";

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcServerRequest {
  id: JsonRpcId | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcIncomingMessage =
  | JsonRpcSuccess
  | JsonRpcFailure
  | JsonRpcNotification
  | JsonRpcServerRequest;

export interface CodexAppServerClientOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  clientInfo?: {
    name: string;
    title: string;
    version: string;
  };
  experimentalApi?: boolean;
  onNotification?: (message: JsonRpcNotification) => void;
  onServerRequest?: (message: JsonRpcServerRequest) => void;
}

export interface CodexAppServerClient {
  start(): Promise<void>;
  initialize(): Promise<unknown>;
  request(method: string, params?: unknown): Promise<unknown>;
  startThread(params: unknown): Promise<unknown>;
  resumeThread(params: unknown): Promise<unknown>;
  startTurn(params: unknown): Promise<unknown>;
  steerTurn(params: unknown): Promise<unknown>;
  interruptTurn(params: unknown): Promise<unknown>;
  listModels(params?: unknown): Promise<unknown>;
  listExperimentalFeatures(params?: unknown): Promise<unknown>;
  readConfig(params: unknown): Promise<unknown>;
  listThreads(params?: unknown): Promise<unknown>;
  readThread(params: unknown): Promise<unknown>;
  listThreadTurns(params: unknown): Promise<unknown>;
  respondToServerRequest(id: JsonRpcId, result: unknown): void;
  notify(method: string, params?: unknown): void;
  close(): Promise<void>;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export class CodexAppServerStdioClient implements CodexAppServerClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdout: ReadlineInterface | null = null;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();

  constructor(private readonly options: CodexAppServerClientOptions = {}) {}

  start(): Promise<void> {
    if (this.process) {
      return Promise.resolve();
    }

    const command = this.options.command ?? "codex";
    const args = this.options.args ?? ["app-server"];
    const child = spawn(command, args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: "pipe",
    });
    this.process = child;
    this.stdout = createInterface({ input: child.stdout });
    this.stdout.on("line", (line) => this.handleLine(line));
    child.on("exit", (code, signal) => {
      this.rejectAll(new Error(`Codex app-server exited: code=${code}, signal=${signal}`));
      this.process = null;
    });
    child.on("error", (error) => {
      this.rejectAll(error);
      this.process = null;
    });

    return Promise.resolve();
  }

  async initialize(): Promise<unknown> {
    await this.start();
    const result = await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? {
        name: "codex_link_mac_host",
        title: "Codex Link Mac Host",
        version: "0.0.0",
      },
      capabilities: {
        experimentalApi: this.options.experimentalApi ?? true,
      },
    });
    this.notify("initialized", {});
    return result;
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const message: JsonRpcRequest = { id, method };
    if (params !== undefined) {
      message.params = params;
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write(message);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  startThread(params: unknown): Promise<unknown> {
    return this.request("thread/start", params);
  }

  resumeThread(params: unknown): Promise<unknown> {
    return this.request("thread/resume", params);
  }

  startTurn(params: unknown): Promise<unknown> {
    return this.request("turn/start", params);
  }

  steerTurn(params: unknown): Promise<unknown> {
    return this.request("turn/steer", params);
  }

  interruptTurn(params: unknown): Promise<unknown> {
    return this.request("turn/interrupt", params);
  }

  listModels(params?: unknown): Promise<unknown> {
    return this.request("model/list", params);
  }

  listExperimentalFeatures(params?: unknown): Promise<unknown> {
    return this.request("experimentalFeature/list", params);
  }

  readConfig(params: unknown): Promise<unknown> {
    return this.request("config/read", params);
  }

  listThreads(params?: unknown): Promise<unknown> {
    return this.request("thread/list", params);
  }

  readThread(params: unknown): Promise<unknown> {
    return this.request("thread/read", params);
  }

  listThreadTurns(params: unknown): Promise<unknown> {
    return this.request("thread/turns/list", params);
  }

  respondToServerRequest(id: JsonRpcId, result: unknown): void {
    this.write({ id, result });
  }

  notify(method: string, params?: unknown): void {
    const message: JsonRpcNotification = { method };
    if (params !== undefined) {
      message.params = params;
    }
    this.write(message);
  }

  close(): Promise<void> {
    const child = this.process;
    this.stdout?.close();
    this.stdout = null;
    if (!child) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
        resolve();
      }, 1000).unref();
    });
  }

  private write(message: JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess): void {
    if (!this.process || !this.process.stdin.writable) {
      throw new Error("Codex app-server is not running");
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    const message = JSON.parse(line) as JsonRpcIncomingMessage;
    if ("id" in message && "method" in message) {
      this.options.onServerRequest?.(message);
      return;
    }
    if ("id" in message) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if ("error" in message) {
        pending.reject(new Error(message.error.message));
        return;
      }
      pending.resolve(message.result);
      return;
    }
    this.options.onNotification?.(message);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export async function createCodexAppServerClient(
  options: CodexAppServerClientOptions = {},
): Promise<CodexAppServerClient> {
  const client = new CodexAppServerStdioClient(options);
  await client.start();
  return client;
}

export interface CodexAppServerWebSocketClientOptions {
  url: string;
  bearerToken?: string | undefined;
  clientInfo?: CodexAppServerClientOptions["clientInfo"];
  experimentalApi?: boolean | undefined;
  onNotification?: (message: JsonRpcNotification) => void;
  onServerRequest?: (message: JsonRpcServerRequest) => void;
}

export class CodexAppServerWebSocketClient implements CodexAppServerClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();

  constructor(private readonly options: CodexAppServerWebSocketClientOptions) {}

  start(): Promise<void> {
    if (this.ws) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (this.options.bearerToken) {
        headers.authorization = `Bearer ${this.options.bearerToken}`;
      }
      const ws = new WebSocket(this.options.url, { headers });
      this.ws = ws;
      const onOpenError = (error: Error) => {
        ws.off("open", onOpen);
        reject(error);
      };
      const onOpen = () => {
        ws.off("error", onOpenError);
        ws.on("error", (error) => {
          this.rejectAll(error instanceof Error ? error : new Error(String(error)));
        });
        ws.on("close", () => {
          this.rejectAll(new Error("Codex app-server WS closed"));
          this.ws = null;
        });
        ws.on("message", (data: RawData) => this.handleData(data));
        resolve();
      };
      ws.once("open", onOpen);
      ws.once("error", onOpenError);
    });
  }

  async initialize(): Promise<unknown> {
    await this.start();
    const result = await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? {
        name: "codex_link_mac_host",
        title: "Codex Link Mac Host",
        version: "0.0.0",
      },
      capabilities: {
        experimentalApi: this.options.experimentalApi ?? true,
      },
    });
    this.notify("initialized", {});
    return result;
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const message: JsonRpcRequest = { id, method };
    if (params !== undefined) {
      message.params = params;
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write(message);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
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

  respondToServerRequest(id: JsonRpcId, result: unknown): void {
    this.write({ id, result });
  }

  notify(method: string, params?: unknown): void {
    const message: JsonRpcNotification = { method };
    if (params !== undefined) {
      message.params = params;
    }
    this.write(message);
  }

  close(): Promise<void> {
    const ws = this.ws;
    if (!ws) return Promise.resolve();
    return new Promise((resolve) => {
      ws.once("close", () => resolve());
      try { ws.close(); } catch { resolve(); }
    });
  }

  private write(message: JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server WS is not open");
    }
    this.ws.send(JSON.stringify(message));
  }

  private handleData(data: RawData): void {
    let text: string;
    if (typeof data === "string") {
      text = data;
    } else if (Array.isArray(data)) {
      text = Buffer.concat(data).toString("utf8");
    } else {
      text = (data as Buffer).toString("utf8");
    }
    let message: JsonRpcIncomingMessage;
    try {
      message = JSON.parse(text) as JsonRpcIncomingMessage;
    } catch {
      return;
    }
    if ("id" in message && "method" in message) {
      this.options.onServerRequest?.(message);
      return;
    }
    if ("id" in message) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if ("error" in message) {
        pending.reject(new Error(message.error.message));
        return;
      }
      pending.resolve(message.result);
      return;
    }
    this.options.onNotification?.(message);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export async function createCodexAppServerWebSocketClient(
  options: CodexAppServerWebSocketClientOptions,
): Promise<CodexAppServerClient> {
  const client = new CodexAppServerWebSocketClient(options);
  await client.start();
  return client;
}
