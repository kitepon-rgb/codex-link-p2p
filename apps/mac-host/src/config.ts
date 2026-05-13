// Mac Host の host.json 設定スキーマと読み書き.
//
// 配置: $CODEX_LINK_HOME (既定 $HOME/.codex-link-p2p) / host.json.
//
// host.json には **session token を保存しない**. token は Keychain (macOS) /
// DPAPI (Windows、後続) / 環境変数 (CODEX_LINK_HOST_TOKEN) のいずれか経由で
// 取得する (token-store.ts).
//
// 既定値:
// - relayUrl: https://codex-link-p2p.kitepon.dynv6.net   (Phase 9 で npm package に
//   ハードコードする本番 URL. Phase 3 では env で上書き可能)
// - codexCommand: "codex"

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  DeviceId,
  HostId,
  HostPlatform,
  UserId,
} from "@codex-link/protocol/rendezvous";

export const DEFAULT_RELAY_URL = "https://codex-link-p2p.kitepon.dynv6.net";
export const DEFAULT_CODEX_COMMAND = "codex";

export interface HostConfig {
  readonly userId: UserId;
  readonly deviceId: DeviceId;
  readonly hostId: HostId;
  readonly displayName: string;
  readonly hostPlatform: HostPlatform;
  readonly relayUrl: string;
  readonly codexCommand: string;
}

export class HostConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostConfigError";
  }
}

export const resolveHostHome = (
  env: Readonly<Record<string, string | undefined>>,
): string => {
  const fromEnv = env["CODEX_LINK_HOME"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".codex-link-p2p");
};

export const resolveHostConfigPath = (
  env: Readonly<Record<string, string | undefined>>,
): string => join(resolveHostHome(env), "host.json");

// JSON は不正な値を許す形なので、読み出し後に厳格 validate する.
const requireString = (
  v: unknown,
  field: string,
  { maxLen = 256 }: { maxLen?: number } = {},
): string => {
  if (typeof v !== "string" || v.length === 0 || v.length > maxLen) {
    throw new HostConfigError(
      `host.json: field "${field}" must be a non-empty string (<= ${maxLen})`,
    );
  }
  return v;
};

const requireEnum = <T extends string>(
  v: unknown,
  field: string,
  allowed: readonly T[],
): T => {
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new HostConfigError(
      `host.json: field "${field}" must be one of ${allowed.join("|")}`,
    );
  }
  return v as T;
};

const HOST_PLATFORMS: readonly HostPlatform[] = ["macos", "windows", "linux"];

export const parseHostConfig = (raw: unknown): HostConfig => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HostConfigError("host.json: JSON object required");
  }
  const v = raw as Record<string, unknown>;
  return {
    userId: requireString(v["userId"], "userId") as UserId,
    deviceId: requireString(v["deviceId"], "deviceId") as DeviceId,
    hostId: requireString(v["hostId"], "hostId") as HostId,
    displayName: requireString(v["displayName"], "displayName"),
    hostPlatform: requireEnum(v["hostPlatform"], "hostPlatform", HOST_PLATFORMS),
    relayUrl:
      v["relayUrl"] === undefined
        ? DEFAULT_RELAY_URL
        : requireString(v["relayUrl"], "relayUrl", { maxLen: 1024 }),
    codexCommand:
      v["codexCommand"] === undefined
        ? DEFAULT_CODEX_COMMAND
        : requireString(v["codexCommand"], "codexCommand"),
  };
};

export const loadHostConfig = async (path: string): Promise<HostConfig> => {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new HostConfigError(
        `host.json not found at ${path}. Run \`codex-link host init\` first.`,
      );
    }
    throw new HostConfigError(`failed to read ${path}: ${err.message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new HostConfigError(
      `host.json: invalid JSON at ${path}: ${(e as Error).message}`,
    );
  }
  return parseHostConfig(parsed);
};

export const writeHostConfig = async (
  path: string,
  config: HostConfig,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const ordered: Record<string, unknown> = {
    userId: config.userId,
    deviceId: config.deviceId,
    hostId: config.hostId,
    displayName: config.displayName,
    hostPlatform: config.hostPlatform,
    relayUrl: config.relayUrl,
    codexCommand: config.codexCommand,
  };
  const data = JSON.stringify(ordered, null, 2) + "\n";
  await writeFile(path, data, { encoding: "utf8", mode: 0o600 });
};

// Relay URL から WS URL を導出 (https → wss, http → ws).
export const wsRelayUrl = (relayUrl: string): string => {
  if (relayUrl.startsWith("https://")) {
    return "wss://" + relayUrl.slice("https://".length);
  }
  if (relayUrl.startsWith("http://")) {
    return "ws://" + relayUrl.slice("http://".length);
  }
  throw new HostConfigError(
    `relayUrl must start with http:// or https://, got ${relayUrl}`,
  );
};
