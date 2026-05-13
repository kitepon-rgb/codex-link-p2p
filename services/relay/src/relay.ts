// Relay の business logic — auth / registry / HostAccess / pairing.
//
// signaling forwarding と TURN credential 発行は別ファイル (Phase 2.3 / 2.4).
//
// 設計メモ:
// - すべての mutator は state を直接書き換える (in-memory state なので OK).
// - session token / pairing code 本体は **発行時に 1 度だけ** 平文で返す.
//   それ以降 Relay は SHA-256 hash しか保持しない.
// - bootstrap token は env から渡される共有秘密。constant-time compare.
// - 失敗は RelayError (code 付き) で報告し、呼び出し側 (HTTP / WS layer) が
//   適切な status code にマップする.

import type {
  DevicePlatform,
  HostAccess,
  HostAccessRole,
  HostId,
  HostPairingCode,
  HostPlatform,
  Host,
  Device,
  DeviceId,
  User,
  UserId,
} from "@codex-link/protocol/rendezvous";

import {
  constantTimeEqual,
  generateDeviceId,
  generateHostId,
  generateOpaqueToken,
  generatePairingCode,
  generateUserId,
  normalizePairingCode,
  sha256Hex,
} from "./ids.js";
import {
  hostAccessKey,
  recordAudit,
  type AuditEvent,
  type AuditEventKind,
  type AuditOutcome,
  type DeviceRecord,
  type RelayState,
} from "./state.js";

// ===== RelayError =====

export type RelayErrorCode =
  | "invalid_bootstrap_token"
  | "invalid_session_token"
  | "device_revoked"
  | "user_not_found"
  | "host_not_found"
  | "device_not_found"
  | "pairing_code_not_found"
  | "pairing_code_expired"
  | "pairing_code_redeemed"
  | "host_access_denied"
  | "rate_limited"
  | "host_offline"
  | "signal_invalid";

export class RelayError extends Error {
  readonly code: RelayErrorCode;
  constructor(code: RelayErrorCode, message: string) {
    super(message);
    this.name = "RelayError";
    this.code = code;
  }
}

// ===== Audit helper =====

interface AuditInput {
  readonly state: RelayState;
  readonly maxEvents: number;
  readonly at: number;
  readonly kind: AuditEventKind;
  readonly outcome: AuditOutcome;
  readonly userId?: UserId | null;
  readonly deviceId?: DeviceId | null;
  readonly hostId?: HostId | null;
  readonly note?: string;
}

const audit = (input: AuditInput): AuditEvent => {
  const event: AuditEvent = {
    at: input.at,
    kind: input.kind,
    outcome: input.outcome,
    userId: input.userId ?? null,
    deviceId: input.deviceId ?? null,
    hostId: input.hostId ?? null,
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
  recordAudit({ state: input.state, event, maxEvents: input.maxEvents });
  return event;
};

// ===== User =====

export interface CreateUserInput {
  readonly state: RelayState;
  readonly now: number;
  readonly maxAuditEvents: number;
}

export interface CreateUserResult {
  readonly user: User;
}

export const createUser = ({
  state,
  now,
  maxAuditEvents,
}: CreateUserInput): CreateUserResult => {
  const user: User = {
    id: generateUserId(),
    createdAt: now,
  };
  state.users.set(user.id, user);
  audit({
    state,
    maxEvents: maxAuditEvents,
    at: now,
    kind: "user.created",
    outcome: "ok",
    userId: user.id,
  });
  return { user };
};

// ===== Device =====

export interface CreateDeviceInput {
  readonly state: RelayState;
  readonly userId: UserId;
  readonly displayName: string;
  readonly platform: DevicePlatform;
  readonly now: number;
  readonly maxAuditEvents: number;
}

export interface CreateDeviceResult {
  readonly device: Device;
  // 平文 session token. 発行時に **1 度だけ** 呼び出し側に返す。
  // Relay は sha256Hex(sessionToken) しか保存しない.
  readonly sessionToken: string;
}

export const createDevice = ({
  state,
  userId,
  displayName,
  platform,
  now,
  maxAuditEvents,
}: CreateDeviceInput): CreateDeviceResult => {
  if (!state.users.has(userId)) {
    throw new RelayError("user_not_found", `user ${userId as string} not found`);
  }
  const deviceId = generateDeviceId();
  const sessionToken = generateOpaqueToken();
  const sessionTokenHash = sha256Hex(sessionToken);

  const record: DeviceRecord = {
    id: deviceId,
    userId,
    displayName,
    platform,
    createdAt: now,
    lastSeenAt: now,
    sessionTokenHash,
  };
  state.devices.set(deviceId, record);
  state.deviceTokenHashIndex.set(sessionTokenHash, deviceId);

  audit({
    state,
    maxEvents: maxAuditEvents,
    at: now,
    kind: "device.created",
    outcome: "ok",
    userId,
    deviceId,
  });

  // protocol Device は tokenHash を持たない wire 型として返す.
  const { sessionTokenHash: _omit, revokedAt: _omit2, ...wireDevice } = record;
  void _omit;
  void _omit2;
  return { device: wireDevice, sessionToken };
};

// ===== Authenticate device session =====

export interface AuthenticateDeviceSessionInput {
  readonly state: RelayState;
  readonly providedSessionToken: string;
  readonly now: number;
}

export const authenticateDeviceSession = ({
  state,
  providedSessionToken,
  now,
}: AuthenticateDeviceSessionInput): DeviceRecord => {
  const hash = sha256Hex(providedSessionToken);
  const deviceId = state.deviceTokenHashIndex.get(hash);
  if (deviceId === undefined) {
    throw new RelayError("invalid_session_token", "session token not recognized");
  }
  const record = state.devices.get(deviceId);
  if (record === undefined) {
    // インデックス整合性の欠陥。防御的に index も掃除する。
    state.deviceTokenHashIndex.delete(hash);
    throw new RelayError("invalid_session_token", "device record vanished");
  }
  if (record.revokedAt !== undefined) {
    throw new RelayError(
      "device_revoked",
      `device ${deviceId as string} is revoked`,
    );
  }
  // lastSeenAt を更新して、新しい record を返す.
  const updated: DeviceRecord = { ...record, lastSeenAt: now };
  state.devices.set(deviceId, updated);
  return updated;
};

// ===== Device session revoke =====

export interface RevokeDeviceSessionInput {
  readonly state: RelayState;
  readonly deviceId: DeviceId;
  readonly now: number;
  readonly maxAuditEvents: number;
}

export const revokeDeviceSession = ({
  state,
  deviceId,
  now,
  maxAuditEvents,
}: RevokeDeviceSessionInput): void => {
  const record = state.devices.get(deviceId);
  if (record === undefined) {
    throw new RelayError(
      "device_not_found",
      `device ${deviceId as string} not found`,
    );
  }
  state.devices.set(deviceId, { ...record, revokedAt: now });
  state.deviceTokenHashIndex.delete(record.sessionTokenHash);

  audit({
    state,
    maxEvents: maxAuditEvents,
    at: now,
    kind: "device.session.revoked",
    outcome: "ok",
    userId: record.userId,
    deviceId,
  });
};

// ===== Host bootstrap =====
//
// Mac/Win Host が初回起動時に bootstrap token (env 共有秘密) を提示し、
// Relay が新規 User + Device + Host を発行して device session token を
// 平文で返す。Mac Host はその token を Keychain に保存する。

export interface BootstrapHostInput {
  readonly state: RelayState;
  readonly providedBootstrapToken: string;
  readonly configuredBootstrapToken: string;
  readonly userDisplayName: string;
  readonly hostDisplayName: string;
  readonly hostPlatform: HostPlatform;
  readonly devicePlatform: DevicePlatform;
  readonly now: number;
  readonly maxAuditEvents: number;
}

export interface BootstrapHostResult {
  readonly user: User;
  readonly host: Host;
  readonly device: Device;
  readonly sessionToken: string;
  readonly hostAccess: HostAccess;
}

export const bootstrapHost = ({
  state,
  providedBootstrapToken,
  configuredBootstrapToken,
  userDisplayName,
  hostDisplayName,
  hostPlatform,
  devicePlatform,
  now,
  maxAuditEvents,
}: BootstrapHostInput): BootstrapHostResult => {
  if (!constantTimeEqual(providedBootstrapToken, configuredBootstrapToken)) {
    audit({
      state,
      maxEvents: maxAuditEvents,
      at: now,
      kind: "host.bootstrap",
      outcome: "denied",
      note: "invalid bootstrap token",
    });
    throw new RelayError(
      "invalid_bootstrap_token",
      "bootstrap token does not match",
    );
  }

  void userDisplayName; // 現状 User に displayName フィールドは無い (将来追加).

  const { user } = createUser({ state, now, maxAuditEvents });
  const { device, sessionToken } = createDevice({
    state,
    userId: user.id,
    displayName: hostDisplayName,
    platform: devicePlatform,
    now,
    maxAuditEvents,
  });

  const host: Host = {
    id: generateHostId(),
    ownerUserId: user.id,
    displayName: hostDisplayName,
    platform: hostPlatform,
    createdAt: now,
  };
  state.hosts.set(host.id, host);

  const access: HostAccess = {
    hostId: host.id,
    userId: user.id,
    role: "owner",
    grantedAt: now,
  };
  state.hostAccess.set(hostAccessKey(host.id, user.id), access);

  audit({
    state,
    maxEvents: maxAuditEvents,
    at: now,
    kind: "host.bootstrap",
    outcome: "ok",
    userId: user.id,
    deviceId: device.id,
    hostId: host.id,
  });
  audit({
    state,
    maxEvents: maxAuditEvents,
    at: now,
    kind: "host.access.granted",
    outcome: "ok",
    userId: user.id,
    hostId: host.id,
    note: "owner",
  });

  return { user, host, device, sessionToken, hostAccess: access };
};

// ===== Pairing code =====
//
// Host が「他デバイスを招待」する短命 code を作る。Host 1 つにつき active
// は 1 件まで (新しく作ると古いものは上書きされる).

export interface CreatePairingCodeInput {
  readonly state: RelayState;
  readonly hostId: HostId;
  readonly createdByDeviceId: DeviceId;
  readonly now: number;
  readonly ttlMs: number;
  readonly maxAuditEvents: number;
}

export interface CreatePairingCodeResult {
  // 平文 code. 呼び出し側 (Host) が iPhone に表示する。
  readonly code: string;
  readonly record: HostPairingCode;
}

export const createPairingCode = ({
  state,
  hostId,
  createdByDeviceId,
  now,
  ttlMs,
  maxAuditEvents,
}: CreatePairingCodeInput): CreatePairingCodeResult => {
  if (!state.hosts.has(hostId)) {
    throw new RelayError(
      "host_not_found",
      `host ${hostId as string} not found`,
    );
  }
  if (!state.devices.has(createdByDeviceId)) {
    throw new RelayError(
      "device_not_found",
      `device ${createdByDeviceId as string} not found`,
    );
  }
  const code = generatePairingCode();
  const record: HostPairingCode = {
    hostId,
    codeHash: sha256Hex(normalizePairingCode(code)),
    expiresAt: now + ttlMs,
    createdByDeviceId,
    redeemed: false,
  };
  state.pairingCodes.set(hostId, record);

  audit({
    state,
    maxEvents: maxAuditEvents,
    at: now,
    kind: "pairing.created",
    outcome: "ok",
    deviceId: createdByDeviceId,
    hostId,
  });

  return { code, record };
};

// ===== Redeem pairing code =====
//
// iPhone (= 既に device session を持つ) が code をスキャンして送る。
// Relay は normalize → hash → 一致する Host を探す → 期限と redeemed
// フラグを確認 → HostAccess を operator として grant する.

export interface RedeemPairingCodeInput {
  readonly state: RelayState;
  readonly providedCode: string;
  readonly redeemingUserId: UserId;
  readonly redeemingDeviceId: DeviceId;
  readonly role: HostAccessRole;
  readonly now: number;
  readonly maxAuditEvents: number;
}

export interface RedeemPairingCodeResult {
  readonly hostAccess: HostAccess;
  readonly hostId: HostId;
}

export const redeemPairingCode = ({
  state,
  providedCode,
  redeemingUserId,
  redeemingDeviceId,
  role,
  now,
  maxAuditEvents,
}: RedeemPairingCodeInput): RedeemPairingCodeResult => {
  if (!state.users.has(redeemingUserId)) {
    throw new RelayError(
      "user_not_found",
      `user ${redeemingUserId as string} not found`,
    );
  }
  if (!state.devices.has(redeemingDeviceId)) {
    throw new RelayError(
      "device_not_found",
      `device ${redeemingDeviceId as string} not found`,
    );
  }
  const normalized = normalizePairingCode(providedCode);
  const targetHash = sha256Hex(normalized);

  let matchedHostId: HostId | undefined;
  let matchedRecord: HostPairingCode | undefined;
  for (const [hostId, record] of state.pairingCodes) {
    if (constantTimeEqual(record.codeHash, targetHash)) {
      matchedHostId = hostId;
      matchedRecord = record;
      break;
    }
  }

  if (matchedHostId === undefined || matchedRecord === undefined) {
    audit({
      state,
      maxEvents: maxAuditEvents,
      at: now,
      kind: "pairing.redeemed",
      outcome: "denied",
      userId: redeemingUserId,
      deviceId: redeemingDeviceId,
      note: "code not found",
    });
    throw new RelayError(
      "pairing_code_not_found",
      "pairing code does not match any active code",
    );
  }
  if (matchedRecord.redeemed) {
    audit({
      state,
      maxEvents: maxAuditEvents,
      at: now,
      kind: "pairing.redeemed",
      outcome: "denied",
      userId: redeemingUserId,
      deviceId: redeemingDeviceId,
      hostId: matchedHostId,
      note: "already redeemed",
    });
    throw new RelayError(
      "pairing_code_redeemed",
      "pairing code already redeemed",
    );
  }
  if (matchedRecord.expiresAt < now) {
    audit({
      state,
      maxEvents: maxAuditEvents,
      at: now,
      kind: "pairing.expired",
      outcome: "expired",
      userId: redeemingUserId,
      deviceId: redeemingDeviceId,
      hostId: matchedHostId,
    });
    throw new RelayError(
      "pairing_code_expired",
      "pairing code has expired",
    );
  }

  state.pairingCodes.set(matchedHostId, { ...matchedRecord, redeemed: true });

  const access: HostAccess = {
    hostId: matchedHostId,
    userId: redeemingUserId,
    role,
    grantedAt: now,
  };
  state.hostAccess.set(hostAccessKey(matchedHostId, redeemingUserId), access);

  audit({
    state,
    maxEvents: maxAuditEvents,
    at: now,
    kind: "pairing.redeemed",
    outcome: "ok",
    userId: redeemingUserId,
    deviceId: redeemingDeviceId,
    hostId: matchedHostId,
  });
  audit({
    state,
    maxEvents: maxAuditEvents,
    at: now,
    kind: "host.access.granted",
    outcome: "ok",
    userId: redeemingUserId,
    hostId: matchedHostId,
    note: role,
  });

  return { hostAccess: access, hostId: matchedHostId };
};

// ===== Host access guard =====

export interface AssertHostAccessInput {
  readonly state: RelayState;
  readonly userId: UserId;
  readonly hostId: HostId;
}

// HostAccess が存在しなければ throw する。signal forwarding / TURN credential
// 発行などの per-host action の入口で必ず呼ぶ。
export const assertHostAccess = ({
  state,
  userId,
  hostId,
}: AssertHostAccessInput): HostAccess => {
  const access = state.hostAccess.get(hostAccessKey(hostId, userId));
  if (access === undefined) {
    throw new RelayError(
      "host_access_denied",
      `user ${userId as string} has no access to host ${hostId as string}`,
    );
  }
  return access;
};

// 取り消し (owner / operator が他 user を切る場合).
export interface RevokeHostAccessInput {
  readonly state: RelayState;
  readonly userId: UserId;
  readonly hostId: HostId;
  readonly now: number;
  readonly maxAuditEvents: number;
}

export const revokeHostAccess = ({
  state,
  userId,
  hostId,
  now,
  maxAuditEvents,
}: RevokeHostAccessInput): void => {
  const key = hostAccessKey(hostId, userId);
  if (!state.hostAccess.has(key)) {
    throw new RelayError(
      "host_access_denied",
      `no access record for ${userId as string} on ${hostId as string}`,
    );
  }
  state.hostAccess.delete(key);
  audit({
    state,
    maxEvents: maxAuditEvents,
    at: now,
    kind: "host.access.revoked",
    outcome: "ok",
    userId,
    hostId,
  });
};
