// Relay 起動時設定。
//
// 環境変数から値を読み出し、型付きの RelayConfig を返す。フォールバックは
// CLAUDE.md 鉄則に基づき最小限。security-critical な値 (TURN_SHARED_SECRET)
// は欠落していたら起動を拒否する。

export interface RelayRateLimitConfig {
  readonly turnCredentialPerMinute: number;
  readonly signalForwardPerMinute: number;
  readonly pairingCreatePerMinute: number;
}

export interface RelayConfig {
  readonly relayUrl: string;
  readonly bindHost: string;
  readonly port: number;
  readonly maxHttpBodyBytes: number;
  readonly maxWebsocketPayloadBytes: number;
  readonly pendingSignalTtlMs: number;
  readonly pairingCodeTtlMs: number;
  readonly auditRetentionMs: number;
  readonly auditMaxEvents: number;
  readonly hostBootstrapToken: string;
  readonly turnSharedSecret: string;
  readonly turnRealm: string;
  readonly turnUrls: readonly string[];
  readonly turnCredentialTtlSec: number;
  readonly rateLimit: RelayRateLimitConfig;
}

export interface LoadConfigOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
}

export class RelayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayConfigError";
  }
}

const requireEnv = (
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string => {
  const value = env[key];
  if (value === undefined || value === "") {
    throw new RelayConfigError(`required env var missing: ${key}`);
  }
  return value;
};

const parseInteger = (
  raw: string,
  key: string,
  { min, max }: { min?: number; max?: number } = {},
): number => {
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new RelayConfigError(`env var ${key} must be an integer, got ${raw}`);
  }
  if (min !== undefined && value < min) {
    throw new RelayConfigError(`env var ${key} must be >= ${min}, got ${value}`);
  }
  if (max !== undefined && value > max) {
    throw new RelayConfigError(`env var ${key} must be <= ${max}, got ${value}`);
  }
  return value;
};

const optionalInt = (
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  fallback: number,
  bounds?: { min?: number; max?: number },
): number => {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  return parseInteger(raw, key, bounds);
};

const parseTurnUrls = (raw: string): readonly string[] => {
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (items.length === 0) {
    throw new RelayConfigError("TURN_URLS must contain at least one URL");
  }
  for (const url of items) {
    if (
      !url.startsWith("stun:") &&
      !url.startsWith("stuns:") &&
      !url.startsWith("turn:") &&
      !url.startsWith("turns:")
    ) {
      throw new RelayConfigError(
        `TURN_URLS entry must start with stun(s):/turn(s):, got ${url}`,
      );
    }
  }
  return items;
};

export const loadConfig = ({ env }: LoadConfigOptions): RelayConfig => {
  const turnSharedSecret = requireEnv(env, "TURN_SHARED_SECRET");
  const hostBootstrapToken = requireEnv(env, "CODEX_LINK_HOST_BOOTSTRAP_TOKEN");
  const turnRealm = env["TURN_REALM"] ?? "codex-link-p2p.local";
  const turnUrlsRaw =
    env["TURN_URLS"] ?? "stun:stun.l.google.com:19302";
  const turnUrls = parseTurnUrls(turnUrlsRaw);

  const relayUrl = env["CODEX_LINK_RELAY_URL"] ?? "http://127.0.0.1:3000";
  const bindHost = env["CODEX_LINK_BIND_HOST"] ?? "0.0.0.0";
  const port = optionalInt(env, "PORT", 3000, { min: 1, max: 65535 });

  return {
    relayUrl,
    bindHost,
    port,
    maxHttpBodyBytes: optionalInt(env, "MAX_HTTP_BODY_BYTES", 64 * 1024, {
      min: 1024,
    }),
    maxWebsocketPayloadBytes: optionalInt(
      env,
      "MAX_WS_PAYLOAD_BYTES",
      128 * 1024,
      { min: 1024 },
    ),
    pendingSignalTtlMs: optionalInt(env, "PENDING_SIGNAL_TTL_MS", 30_000, {
      min: 1_000,
    }),
    pairingCodeTtlMs: optionalInt(env, "PAIRING_CODE_TTL_MS", 10 * 60 * 1000, {
      min: 30_000,
    }),
    auditRetentionMs: optionalInt(env, "AUDIT_RETENTION_MS", 60 * 60 * 1000, {
      min: 60_000,
    }),
    auditMaxEvents: optionalInt(env, "AUDIT_MAX_EVENTS", 10_000, {
      min: 100,
    }),
    hostBootstrapToken,
    turnSharedSecret,
    turnRealm,
    turnUrls,
    turnCredentialTtlSec: optionalInt(env, "TURN_CREDENTIAL_TTL_SEC", 300, {
      min: 30,
      max: 24 * 60 * 60,
    }),
    rateLimit: {
      turnCredentialPerMinute: optionalInt(
        env,
        "RATE_TURN_CREDENTIAL_PER_MINUTE",
        30,
        { min: 1 },
      ),
      signalForwardPerMinute: optionalInt(
        env,
        "RATE_SIGNAL_FORWARD_PER_MINUTE",
        600,
        { min: 1 },
      ),
      pairingCreatePerMinute: optionalInt(
        env,
        "RATE_PAIRING_CREATE_PER_MINUTE",
        10,
        { min: 1 },
      ),
    },
  };
};
