// HTTP request handler — Relay の REST surface.
//
// Endpoints:
// - GET  /api/health
// - POST /api/host-bootstrap         (env bootstrap token を提示 → User+Device+Host を発行)
// - POST /api/device-session/register (新規 User+Device を発行 → sessionToken を 1 度返す)
// - POST /api/device-session/pair    (Bearer 認証 + pairingCode → HostAccess grant)
//
// 設計:
// - Node stdlib http のみ。Express 等は使わない (依存最小化).
// - Body は JSON のみ、サイズ上限は config.maxHttpBodyBytes.
// - RelayError は HTTP status に map される (400 / 401 / 403 / 404 / 409 / 429).
// - **payload routing は一切やらない** (CodexLinkEvent は HTTP では受けない).

import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

import type {
  DevicePlatform,
  HostAccessRole,
  HostPlatform,
} from "@codex-link/protocol/rendezvous";

import type { RelayConfig } from "./config.js";
import {
  authenticateDeviceSession,
  bootstrapHost,
  createDevice,
  createUser,
  redeemPairingCode,
  RelayError,
  type RelayErrorCode,
} from "./relay.js";
import type { DeviceRecord, RelayState } from "./state.js";

export interface HttpHandlerContext {
  readonly state: RelayState;
  readonly config: RelayConfig;
  readonly now: () => number;
}

// ===== Error mapping =====

const STATUS_FOR_CODE: Record<RelayErrorCode, number> = {
  invalid_bootstrap_token: 401,
  invalid_session_token: 401,
  device_revoked: 401,
  user_not_found: 404,
  host_not_found: 404,
  device_not_found: 404,
  pairing_code_not_found: 404,
  pairing_code_expired: 410,
  pairing_code_redeemed: 409,
  host_access_denied: 403,
  rate_limited: 429,
  host_offline: 503,
  signal_invalid: 400,
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

// ===== Helpers =====

const writeJson = (
  res: ServerResponse,
  status: number,
  body: unknown,
): void => {
  const data = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(data));
  res.end(data);
};

const writeError = (
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void => {
  writeJson(res, status, { error: { code, message } });
};

const readBody = async (
  req: IncomingMessage,
  maxBytes: number,
): Promise<string> => {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return; // 残りは drain して捨てる
      bytes += chunk.length;
      if (bytes > maxBytes) {
        aborted = true;
        reject(new HttpError(413, `request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (aborted) return;
      reject(err);
    });
  });
};

const parseJson = (raw: string): unknown => {
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch (e) {
    throw new HttpError(400, `invalid JSON body: ${(e as Error).message}`);
  }
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const requireString = (
  v: unknown,
  field: string,
  { maxLen = 256 }: { maxLen?: number } = {},
): string => {
  if (typeof v !== "string" || v.length === 0) {
    throw new HttpError(400, `field "${field}" must be a non-empty string`);
  }
  if (v.length > maxLen) {
    throw new HttpError(
      400,
      `field "${field}" exceeds maxLen ${maxLen}`,
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
    throw new HttpError(
      400,
      `field "${field}" must be one of ${allowed.join("|")}`,
    );
  }
  return v as T;
};

const optionalEnum = <T extends string>(
  v: unknown,
  field: string,
  allowed: readonly T[],
  fallback: T,
): T => {
  if (v === undefined) return fallback;
  return requireEnum(v, field, allowed);
};

const HOST_PLATFORMS = ["macos", "windows", "linux"] as const satisfies readonly HostPlatform[];
const DEVICE_PLATFORMS = ["ios", "macos", "windows", "linux"] as const satisfies readonly DevicePlatform[];
const ACCESS_ROLES = ["owner", "operator", "viewer"] as const satisfies readonly HostAccessRole[];

// Bearer auth — fail-fast, returns 401 on miss / invalid.
const requireBearer = (
  req: IncomingMessage,
  state: RelayState,
  now: number,
): DeviceRecord => {
  const auth = req.headers["authorization"];
  if (typeof auth !== "string") {
    throw new HttpError(401, "missing Authorization header");
  }
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (match === null || match[1] === undefined) {
    throw new HttpError(401, "expected Authorization: Bearer <token>");
  }
  try {
    return authenticateDeviceSession({
      state,
      providedSessionToken: match[1],
      now,
    });
  } catch (e) {
    if (e instanceof RelayError) {
      throw new HttpError(STATUS_FOR_CODE[e.code], e.message);
    }
    throw e;
  }
};

// ===== Wire DTO 形状 (responses) =====
//
// session token / pairing code 平文は **response にだけ** 含める。state には
// 入らない (hash のみ保存). レスポンス側もログにそのまま出さないこと.

interface SessionTokenIssuedDto {
  readonly userId: string;
  readonly deviceId: string;
  readonly sessionToken: string;
  readonly device: unknown;
}

// ===== Handlers =====

const handleHealth = (
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: HttpHandlerContext,
): void => {
  writeJson(res, 200, { ok: true });
};

const handleHostBootstrap = async (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpHandlerContext,
): Promise<void> => {
  const raw = await readBody(req, ctx.config.maxHttpBodyBytes);
  const body = parseJson(raw);
  if (!isPlainObject(body)) {
    throw new HttpError(400, "JSON object body required");
  }
  const bootstrapToken = requireString(body["bootstrapToken"], "bootstrapToken");
  const hostDisplayName = requireString(
    body["hostDisplayName"],
    "hostDisplayName",
  );
  const hostPlatform = requireEnum(
    body["hostPlatform"],
    "hostPlatform",
    HOST_PLATFORMS,
  );
  const devicePlatform = requireEnum(
    body["devicePlatform"],
    "devicePlatform",
    DEVICE_PLATFORMS,
  );
  const userDisplayName =
    typeof body["userDisplayName"] === "string"
      ? (body["userDisplayName"] as string)
      : hostDisplayName;

  const now = ctx.now();
  const r = bootstrapHost({
    state: ctx.state,
    providedBootstrapToken: bootstrapToken,
    configuredBootstrapToken: ctx.config.hostBootstrapToken,
    userDisplayName,
    hostDisplayName,
    hostPlatform,
    devicePlatform,
    now,
    maxAuditEvents: ctx.config.auditMaxEvents,
  });

  const dto: SessionTokenIssuedDto & {
    readonly host: typeof r.host;
    readonly hostAccess: typeof r.hostAccess;
  } = {
    userId: r.user.id as string,
    deviceId: r.device.id as string,
    sessionToken: r.sessionToken,
    device: r.device,
    host: r.host,
    hostAccess: r.hostAccess,
  };
  writeJson(res, 201, dto);
};

const handleDeviceRegister = async (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpHandlerContext,
): Promise<void> => {
  const raw = await readBody(req, ctx.config.maxHttpBodyBytes);
  const body = parseJson(raw);
  if (!isPlainObject(body)) {
    throw new HttpError(400, "JSON object body required");
  }
  const displayName = requireString(body["displayName"], "displayName");
  const platform = requireEnum(body["platform"], "platform", DEVICE_PLATFORMS);

  const now = ctx.now();
  const { user } = createUser({
    state: ctx.state,
    now,
    maxAuditEvents: ctx.config.auditMaxEvents,
  });
  const { device, sessionToken } = createDevice({
    state: ctx.state,
    userId: user.id,
    displayName,
    platform,
    now,
    maxAuditEvents: ctx.config.auditMaxEvents,
  });

  const dto: SessionTokenIssuedDto = {
    userId: user.id as string,
    deviceId: device.id as string,
    sessionToken,
    device,
  };
  writeJson(res, 201, dto);
};

const handleDevicePair = async (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpHandlerContext,
): Promise<void> => {
  const now = ctx.now();
  const auth = requireBearer(req, ctx.state, now);
  const raw = await readBody(req, ctx.config.maxHttpBodyBytes);
  const body = parseJson(raw);
  if (!isPlainObject(body)) {
    throw new HttpError(400, "JSON object body required");
  }
  const code = requireString(body["pairingCode"], "pairingCode", { maxLen: 64 });
  const role = optionalEnum(body["role"], "role", ACCESS_ROLES, "operator");

  const r = redeemPairingCode({
    state: ctx.state,
    providedCode: code,
    redeemingUserId: auth.userId,
    redeemingDeviceId: auth.id,
    role,
    now,
    maxAuditEvents: ctx.config.auditMaxEvents,
  });

  writeJson(res, 200, {
    hostId: r.hostId as string,
    hostAccess: r.hostAccess,
  });
};

// ===== Top-level dispatcher =====

export const createHttpHandler =
  (ctx: HttpHandlerContext): RequestListener =>
  (req, res) => {
    void (async () => {
      try {
        const path = req.url ?? "";
        // Strip query string for routing match.
        const pathOnly = path.split("?")[0] ?? "";
        const method = req.method ?? "GET";

        if (method === "GET" && pathOnly === "/api/health") {
          handleHealth(req, res, ctx);
          return;
        }
        if (method === "POST" && pathOnly === "/api/host-bootstrap") {
          await handleHostBootstrap(req, res, ctx);
          return;
        }
        if (method === "POST" && pathOnly === "/api/device-session/register") {
          await handleDeviceRegister(req, res, ctx);
          return;
        }
        if (method === "POST" && pathOnly === "/api/device-session/pair") {
          await handleDevicePair(req, res, ctx);
          return;
        }

        writeError(res, 404, "not_found", `no route for ${method} ${pathOnly}`);
      } catch (e) {
        if (e instanceof HttpError) {
          writeError(res, e.status, "http_error", e.message);
          return;
        }
        if (e instanceof RelayError) {
          writeError(
            res,
            STATUS_FOR_CODE[e.code] ?? 500,
            e.code,
            e.message,
          );
          return;
        }
        writeError(
          res,
          500,
          "internal_error",
          (e as Error).message ?? "unknown error",
        );
      }
    })();
  };
