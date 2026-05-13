#!/usr/bin/env node
// `codex-link-host` CLI.
//
// サブコマンド:
//   init   - Relay へ bootstrap し、user/device/host を発行して host.json と
//            token store に保存する. 初期 pairing code を表示する.
//   start  - host.json を読み、Relay へ signaling 接続し、peer 待受 + Codex
//            event の broadcast を開始する.
//   pair   - start 中のホストに別途 pairing code を作るためのオプションは
//            将来. 現状の `init` / `start` 中の REPL 出力で代用.
//
// 起動例:
//   codex-link-host init --relay https://codex-link.kitepon.dynv6.net \
//                        --bootstrap-token $BOOT \
//                        --display-name "kite Mac"
//   codex-link-host start

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_RELAY_URL,
  loadHostConfig,
  resolveHostConfigPath,
  type HostConfig,
  writeHostConfig,
} from "./config.js";
import { detectCapabilities } from "./capabilities.js";
import {
  type CodexClient,
  NullCodexClient,
} from "./codex.js";
import { PeerManager, type PeerKey } from "./peer.js";
import {
  SignalingClient,
  type SignalingClientHandlers,
} from "./signaling-client.js";
import { SessionManager } from "./session.js";
import { resolveTokenStore, type TokenStore } from "./token-store.js";
import type {
  HostPlatform,
  UserId,
  DeviceId,
  HostId,
} from "@codex-link/protocol/rendezvous";

const STDOUT = process.stdout;
const STDERR = process.stderr;

const log = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void => {
  const obj: Record<string, unknown> = { level, msg };
  if (extra) Object.assign(obj, extra);
  const line = JSON.stringify(obj) + "\n";
  if (level === "error") STDERR.write(line);
  else STDOUT.write(line);
};

const help = (): string =>
  [
    "Usage:",
    "  codex-link-host init   [--relay URL] [--bootstrap-token T] [--display-name N] [--host-platform macos|windows|linux]",
    "  codex-link-host start  [--relay URL]",
    "  codex-link-host help",
    "",
    "Environment overrides:",
    "  CODEX_LINK_RELAY_URL            Default relay URL",
    "  CODEX_LINK_HOST_BOOTSTRAP_TOKEN Bootstrap token (init only)",
    "  CODEX_LINK_HOME                 Config / token directory (default: ~/.codex-link-p2p)",
    "  CODEX_LINK_HOST_TOKEN           Use this session token instead of reading from store",
  ].join("\n");

const parseArgs = (argv: readonly string[]): Record<string, string | true> => {
  const args: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    }
  }
  return args;
};

const detectHostPlatform = (raw: string | undefined): HostPlatform => {
  if (raw === "macos" || raw === "windows" || raw === "linux") return raw;
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
};

const fetchJson = async (
  url: string,
  method: "GET" | "POST",
  body?: unknown,
  headers?: Record<string, string>,
): Promise<unknown> => {
  const init: RequestInit = {
    method,
    headers: {
      "content-type": "application/json",
      ...(headers ?? {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  const r = await fetch(url, init);
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`HTTP ${r.status} ${r.statusText}: ${text}`);
  }
  if (text.length === 0) return undefined;
  return JSON.parse(text) as unknown;
};

// ===== init =====

interface InitOptions {
  readonly relayUrl: string;
  readonly bootstrapToken: string;
  readonly displayName: string;
  readonly hostPlatform: HostPlatform;
  readonly env: Readonly<Record<string, string | undefined>>;
}

interface BootstrapResponse {
  readonly userId: string;
  readonly deviceId: string;
  readonly sessionToken: string;
  readonly host: { readonly id: string };
}

export const runInit = async (opts: InitOptions): Promise<void> => {
  const url = `${opts.relayUrl.replace(/\/$/, "")}/api/host-bootstrap`;
  const body = {
    bootstrapToken: opts.bootstrapToken,
    hostDisplayName: opts.displayName,
    hostPlatform: opts.hostPlatform,
    devicePlatform: opts.hostPlatform,
  };
  const resp = (await fetchJson(url, "POST", body)) as BootstrapResponse;
  const config: HostConfig = {
    userId: resp.userId as UserId,
    deviceId: resp.deviceId as DeviceId,
    hostId: resp.host.id as HostId,
    displayName: opts.displayName,
    hostPlatform: opts.hostPlatform,
    relayUrl: opts.relayUrl,
    codexCommand: "codex",
  };
  const configPath = resolveHostConfigPath(opts.env);
  await writeHostConfig(configPath, config);

  const store = resolveTokenStore({ env: opts.env });
  await store.set(config.userId, config.deviceId, resp.sessionToken);

  log("info", "host_init_complete", {
    userId: config.userId,
    deviceId: config.deviceId,
    hostId: config.hostId,
    configPath,
    tokenStore: store.kind,
  });
  STDOUT.write(
    `\nHost initialized.\n` +
      `  Host ID:    ${config.hostId}\n` +
      `  Config:     ${configPath}\n` +
      `  Token:      stored in ${store.kind}\n\n` +
      `Run \`codex-link-host start\` to start serving iPhone clients.\n`,
  );
};

// ===== start =====

interface StartOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly relayUrlOverride?: string;
  readonly codexClient?: CodexClient;
  readonly turnUrls?: readonly string[];
}

export interface StartedHost {
  readonly signaling: SignalingClient;
  readonly peerManager: PeerManager;
  readonly session: SessionManager;
  readonly stop: () => Promise<void>;
}

export const runStart = async (opts: StartOptions): Promise<StartedHost> => {
  const configPath = resolveHostConfigPath(opts.env);
  const config = await loadHostConfig(configPath);
  const relayUrl = opts.relayUrlOverride ?? config.relayUrl;

  const tokenStore: TokenStore = resolveTokenStore({ env: opts.env });
  const token = await tokenStore.get(config.userId, config.deviceId);
  if (token === null) {
    throw new Error(
      `No session token found in ${tokenStore.kind} store. Run \`codex-link-host init\`.`,
    );
  }

  const capabilities = await detectCapabilities({
    hostId: config.hostId,
    hostPlatform: config.hostPlatform,
    codexCommand: config.codexCommand,
  });

  const codex: CodexClient = opts.codexClient ?? new NullCodexClient();
  await codex.start();

  const turnUrls = opts.turnUrls ?? ["stun:stun.l.google.com:19302"];
  const peerManager = new PeerManager(
    { hostId: config.hostId, iceServers: turnUrls },
    {
      onLocalSignal: (key, reply) => {
        signaling.sendSignalToClient(reply);
        void key;
      },
      onFrame: (key, frame) => session.handlePeerFrame(key, frame),
      onConnectionPathChange: (key, path) => {
        log("info", "peer_path", {
          userId: key.userId,
          deviceId: key.deviceId,
          path,
        });
      },
      onLog: (level, msg, extra) => log(toCliLevel(level), msg, extra),
    },
  );
  peerManager.startStatsLoop();

  const session = new SessionManager({
    hostId: config.hostId,
    hostCapabilities: capabilities,
    codex,
    peers: peerManager,
  });
  session.start();

  const handlers: SignalingClientHandlers = {
    onWelcome: (info) => {
      log("info", "signaling_welcome", {
        userId: info.userId,
        deviceId: info.deviceId,
      });
      // announce 直後に pairing code を作るかは init で済んでいる前提なので
      // 自動では作らない. `pair` subcommand を将来追加.
      signaling.announce(config.hostId);
    },
    onSignalFromClient: (msg) => {
      const env = msg.envelope;
      const key: PeerKey = {
        userId: env.fromUserId,
        deviceId: env.fromDeviceId,
      };
      peerManager.applyClientSignal(key, env.signal, turnUrls);
    },
    onTurnCredential: (msg) => {
      // peer 生成は signal.from_client を受けた時に行う. credential は
      // 自前 peer 用に取り直したいタイミング (ICE restart) で使う.
      log("info", "turn_credential_received", { ttl: msg.credential.ttlSec });
    },
    onPairingCodeIssued: (msg) => {
      STDOUT.write(`\nPairing code: ${msg.code}  (expires ${new Date(msg.expiresAt).toISOString()})\n`);
    },
    onError: (e) => {
      log("warn", "signaling_error", e as unknown as Record<string, unknown>);
    },
    onStateChange: (s) => log("info", "signaling_state", { state: s }),
    onLog: (level, msg, extra) => log(toCliLevel(level), msg, extra),
  };
  const signaling = new SignalingClient({
    relayUrl,
    sessionToken: token,
    handlers,
  });
  signaling.start();

  const stop = async (): Promise<void> => {
    signaling.close();
    peerManager.closeAll();
    session.stop();
    await codex.stop();
  };

  return { signaling, peerManager, session, stop };
};

const toCliLevel = (
  l: "debug" | "info" | "warn" | "error",
): "info" | "warn" | "error" => (l === "debug" ? "info" : l);

// ===== Entry =====

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const sub = argv[0] ?? "help";
  const args = parseArgs(argv.slice(1));
  const env = process.env;

  if (sub === "help" || sub === "--help" || sub === "-h") {
    STDOUT.write(help() + "\n");
    return;
  }

  if (sub === "init") {
    const relayUrl =
      stringArg(args, "relay") ?? env["CODEX_LINK_RELAY_URL"] ?? DEFAULT_RELAY_URL;
    const bootstrapToken =
      stringArg(args, "bootstrap-token") ??
      env["CODEX_LINK_HOST_BOOTSTRAP_TOKEN"];
    if (bootstrapToken === undefined) {
      STDERR.write(
        "--bootstrap-token (or env CODEX_LINK_HOST_BOOTSTRAP_TOKEN) is required\n",
      );
      process.exit(2);
    }
    const displayName =
      stringArg(args, "display-name") ?? `${process.platform} host`;
    const hostPlatform = detectHostPlatform(stringArg(args, "host-platform"));
    await runInit({
      relayUrl,
      bootstrapToken,
      displayName,
      hostPlatform,
      env,
    });
    return;
  }

  if (sub === "start") {
    const relayUrlOverride = stringArg(args, "relay");
    const started = await runStart({
      env,
      ...(relayUrlOverride !== undefined ? { relayUrlOverride } : {}),
    });

    const shutdown = async (): Promise<void> => {
      log("info", "host_shutdown");
      await started.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
    return;
  }

  STDERR.write(`Unknown subcommand: ${sub}\n\n${help()}\n`);
  process.exit(2);
};

const stringArg = (
  args: Record<string, string | true>,
  key: string,
): string | undefined => {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
};

// CLI entry detection (avoid running on import).
//
// `npm i -g @codex-link/host` で入れた場合は bin shim 経由 (= argv[1] が
// `.../node_modules/.bin/codex-link-host` の symlink) で起動される.
// したがって拡張子サフィックス判定ではなく、symlink を解決した上で
// 自分自身 (import.meta.url の realpath) と一致するかで判定する.
const isMain = (): boolean => {
  const a1 = process.argv[1];
  if (typeof a1 !== "string") return false;
  try {
    return realpathSync(a1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  main().catch((err: Error) => {
    STDERR.write(`fatal: ${err.message}\n`);
    process.exit(1);
  });
}
