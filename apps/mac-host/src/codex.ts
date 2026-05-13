// Codex app-server client 抽象化.
//
// Mac Host が `codex app-server --listen ws://127.0.0.1:0` を起動して
// loopback WebSocket で話す経路を「正規」とする. 他経路 (stdio / VS Code IPC
// follower) は将来.
//
// このファイルでは **interface だけ** 定義し、複数 transport を後で差し込める
// 形にしておく. 実 spawn / IPC は Phase 6 で詰める (Codex CLI の事前 install
// が必要なため、本フェーズでは抽象化のみ).

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ===== Public types =====

// Codex app-server から受け取る生 event. type と data の二段だけ強制し、
// 中身は normalizer (codex-events.ts) でハンドリングする.
export interface CodexAppServerEvent {
  readonly type: string;
  readonly data?: Record<string, unknown>;
  readonly threadId?: string;
  readonly id?: string;
}

// Mac Host から Codex に投げるコマンド (UI action 由来).
export interface CodexAppServerCommand {
  readonly type: string;
  readonly data?: Record<string, unknown>;
  readonly threadId?: string;
  readonly id?: string;
}

export interface CodexClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendCommand(cmd: CodexAppServerCommand): Promise<void>;
  // 受信 event をハンドラに流す. 複数登録可.
  onEvent(handler: (e: CodexAppServerEvent) => void): () => void;
  // 接続状態. running = true なら sendCommand 可.
  isRunning(): boolean;
}

// ===== Codex app-server port discovery =====
//
// `codex app-server --listen ws://127.0.0.1:0` は実際の port を出力する.
// 仕様確定までは $TMPDIR/codex-link-app-server.json に port を書き出す
// helper を別に持つこととし、ここでは「port を読み出す」関数だけ用意.

const PORT_FILE = join(tmpdir(), "codex-link-app-server.json");

export interface AppServerPortFile {
  readonly port: number;
  readonly pid: number;
  readonly url: string;
  readonly writtenAt: number;
}

export const writeAppServerPortFile = async (
  info: AppServerPortFile,
): Promise<void> => {
  await mkdir(tmpdir(), { recursive: true });
  await writeFile(PORT_FILE, JSON.stringify(info, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
};

export const readAppServerPortFile = async (): Promise<AppServerPortFile | null> => {
  try {
    const raw = await readFile(PORT_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppServerPortFile>;
    if (
      typeof parsed.port === "number" &&
      typeof parsed.pid === "number" &&
      typeof parsed.url === "string"
    ) {
      return {
        port: parsed.port,
        pid: parsed.pid,
        url: parsed.url,
        writtenAt: parsed.writtenAt ?? 0,
      };
    }
    return null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
};

// ===== NullCodexClient (テスト / Phase 6 まで CLI 無しでも動かせる stub) =====

export class NullCodexClient implements CodexClient {
  private handlers: Set<(e: CodexAppServerEvent) => void> = new Set();
  private running = false;
  private readonly sentCommands: CodexAppServerCommand[] = [];

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async sendCommand(cmd: CodexAppServerCommand): Promise<void> {
    if (!this.running) throw new Error("NullCodexClient is not running");
    this.sentCommands.push(cmd);
  }

  onEvent(handler: (e: CodexAppServerEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  isRunning(): boolean {
    return this.running;
  }

  // ===== Test API =====

  emit(event: CodexAppServerEvent): void {
    for (const h of this.handlers) h(event);
  }

  commandsSent(): readonly CodexAppServerCommand[] {
    return this.sentCommands;
  }
}

// ===== SpawnedCodexClient =====
//
// `codex app-server --listen ws://127.0.0.1:0` を spawn し、出力から port を
// 拾って WebSocket で話す. 実装は Phase 6 (Codex CLI の事前 install が必要)
// で詰める. 現段階では spawn の最低限だけ用意.

export interface SpawnedCodexClientOptions {
  readonly codexCommand: string; // e.g. "codex"
  readonly extraArgs?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

export class SpawnedCodexClient implements CodexClient {
  private child: ChildProcess | null = null;
  private handlers: Set<(e: CodexAppServerEvent) => void> = new Set();
  private readonly options: SpawnedCodexClientOptions;

  constructor(options: SpawnedCodexClientOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.child !== null) return;
    this.child = spawn(
      this.options.codexCommand,
      ["app-server", "--listen", "ws://127.0.0.1:0", ...(this.options.extraArgs ?? [])],
      {
        env: this.options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    // stdout から port 行を拾うのは Phase 6 で実装. 今は spawn 自体の起動だけ.
  }

  async stop(): Promise<void> {
    if (this.child === null) return;
    try {
      this.child.kill("SIGTERM");
    } catch {
      // ignore
    }
    this.child = null;
  }

  async sendCommand(_cmd: CodexAppServerCommand): Promise<void> {
    // Phase 6: WebSocket 経由で送る. 今は noop で throw.
    throw new Error("SpawnedCodexClient.sendCommand is not yet wired in Phase 3.4");
  }

  onEvent(handler: (e: CodexAppServerEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }
}
