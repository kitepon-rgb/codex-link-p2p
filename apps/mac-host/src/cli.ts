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
//   codex-link-host init --relay https://codex-link-p2p.kitepon.dynv6.net \
//                        --bootstrap-token $BOOT \
//                        --display-name "kite Mac"
//   codex-link-host start

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import qrcode from "qrcode-terminal";

import {
  DEFAULT_RELAY_URL,
  loadHostConfig,
  resolveHostConfigPath,
  type HostConfig,
  writeHostConfig,
} from "./config.js";
import { detectCapabilities } from "./capabilities.js";
import { NullCodexClient, ResilientCodexClient } from "./codex.js";
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
import { asProjectId, type ProjectId } from "@codex-link/protocol/session";
import type { CodexAppServerClient } from "@codex-link/codex-client";

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
    "  codex-link-host start  [--relay URL] [--use-null-codex]",
    "  codex-link-host pair   [--relay URL]   (issue a pairing code + QR for iPhone scanning)",
    "  codex-link-host help",
    "",
    "start flags:",
    "  --use-null-codex    spawn の代わりに stub Codex を使う (Codex CLI 未 install 環境向け)",
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
  /** Optional Codex client injection for tests. If absent and `useNullCodex` is true, uses NullCodexClient. Otherwise spawns real `codex app-server`. */
  readonly codexClient?: CodexAppServerClient;
  readonly useNullCodex?: boolean;
  readonly turnUrls?: readonly string[];
  /** Project ID to associate Codex events with. Default: derived from hostId. */
  readonly defaultProjectId?: ProjectId;
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

  // Codex client: either injected (tests), null (offline dev), or real (default).
  let codex: CodexAppServerClient;
  let codexCleanup: () => Promise<void> = async () => {};
  if (opts.codexClient !== undefined) {
    codex = opts.codexClient;
  } else if (opts.useNullCodex === true) {
    codex = new NullCodexClient({
      onNotification: (n) => session.handleCodexNotification(n),
      onServerRequest: (r) => session.handleCodexServerRequest(r),
    });
  } else {
    const resilient = new ResilientCodexClient({
      codexCommand: config.codexCommand,
      onNotification: (n) => session.handleCodexNotification(n),
      onServerRequest: (r) => session.handleCodexServerRequest(r),
      onRespawn: (info) => log("warn", "codex_respawned", info as unknown as Record<string, unknown>),
    });
    await resilient.start();
    codex = resilient;
    codexCleanup = async () => {
      try {
        await resilient.close();
      } catch {
        /* ignore */
      }
    };
    log("info", "codex_app_server_started", { resilient: true });
  }

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

  const defaultProjectId =
    opts.defaultProjectId ?? asProjectId(`${config.hostId as string}:default`);

  const session = new SessionManager({
    hostId: config.hostId,
    hostCapabilities: capabilities,
    codex,
    peers: peerManager,
    defaultProjectId,
  });

  const handlers: SignalingClientHandlers = {
    onWelcome: (info) => {
      log("info", "signaling_welcome", {
        userId: info.userId,
        deviceId: info.deviceId,
      });
      // 前回 WS 接続で確立した peer は再 welcome 後は相手側 (Relay / iPhone)
      // から見て stale なので一旦全消去する. 初回 welcome では peer 0 なので
      // no-op.
      peerManager.dropAllPeers();
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
    await codexCleanup();
    void session; // keep reference so it isn't GC'd before stop
    void codex;
  };

  return { signaling, peerManager, session, stop };
};

// ===== pair (one-shot pairing code issuer) =====

interface PairOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly relayUrlOverride?: string;
}

export const runPair = async (opts: PairOptions): Promise<void> => {
  const configPath = resolveHostConfigPath(opts.env);
  const config = await loadHostConfig(configPath);
  const relayUrl = opts.relayUrlOverride ?? config.relayUrl;

  const tokenStore = resolveTokenStore({ env: opts.env });
  const token = await tokenStore.get(config.userId, config.deviceId);
  if (token === null) {
    throw new Error(
      `No session token found in ${tokenStore.kind} store. Run \`codex-link-host init\`.`,
    );
  }

  const code: string = await new Promise((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      signaling.close();
      reject(new Error("Timed out waiting for pairing_code.issued (10s)"));
    }, 10_000);

    const signaling = new SignalingClient({
      relayUrl,
      sessionToken: token,
      handlers: {
        onWelcome: () => {
          signaling.announce(config.hostId);
          signaling.createPairingCode(config.hostId);
        },
        onPairingCodeIssued: (msg) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          signaling.close();
          resolve(msg.code);
        },
        onError: (e) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          signaling.close();
          reject(new Error(`signaling error: ${JSON.stringify(e)}`));
        },
        onLog: () => {},
      },
    });
    signaling.start();
  });

  // QR の payload: iPhone は relayUrl で `/api/device-session/register` を叩いて
  // 新規 (userId, deviceId, sessionToken) を取得し、その Bearer で
  // `/api/device-session/pair` に pairingCode + hostId を投げて HostAccess を
  // grant してもらう. iOS 側 OnboardingView の QR scanner がこの JSON を decode
  // してそのまま使う.
  const payload: PairingPayload = {
    v: 1,
    relayUrl,
    pairingCode: code,
    hostId: config.hostId as string,
  };
  const json = JSON.stringify(payload);

  STDOUT.write(`\nPairing code: ${code}\n`);
  STDOUT.write(`Relay URL:    ${relayUrl}\n`);
  STDOUT.write(`Host ID:      ${config.hostId as string}\n\n`);
  STDOUT.write("Scan this QR with the iPhone app:\n\n");
  // qrcode-terminal は callback で render 結果を返す. console には書き込まず、
  // STDOUT に統一する.
  await new Promise<void>((resolveDraw) => {
    qrcode.generate(json, { small: true }, (rendered) => {
      STDOUT.write(`${rendered}\n`);
      resolveDraw();
    });
  });
  STDOUT.write("(or copy the JSON below into the app)\n");
  STDOUT.write(`${json}\n`);
};

export interface PairingPayload {
  readonly v: 1;
  readonly relayUrl: string;
  readonly pairingCode: string;
  readonly hostId: string;
}

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
    const useNullCodex = args["use-null-codex"] === true;
    const started = await runStart({
      env,
      ...(relayUrlOverride !== undefined ? { relayUrlOverride } : {}),
      ...(useNullCodex ? { useNullCodex: true } : {}),
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

  if (sub === "pair") {
    const relayUrlOverride = stringArg(args, "relay");
    await runPair({
      env,
      ...(relayUrlOverride !== undefined ? { relayUrlOverride } : {}),
    });
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
