// ID / token / pairing code 生成と hash ユーティリティ.
//
// - ID: UUID v4 に短い prefix を付けて debug しやすくする (usr_/dev_/hst_).
// - opaque token: 32 byte random を base64url. device session token / pairing
//   code 平文は **発行時に 1 度だけ** 返し、Relay は SHA-256 hash のみ保存する.
// - pairing code: Crockford base32 (I / L / O / U を除外) 8 文字。短く読みやすく.
// - constantTimeEqual: timing 攻撃を避けるための文字列比較.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import {
  asDeviceId,
  asHostId,
  asUserId,
  type DeviceId,
  type HostId,
  type UserId,
} from "@codex-link/protocol/rendezvous";

export const generateUserId = (): UserId => asUserId(`usr_${randomUUID()}`);
export const generateDeviceId = (): DeviceId => asDeviceId(`dev_${randomUUID()}`);
export const generateHostId = (): HostId => asHostId(`hst_${randomUUID()}`);

export const generateOpaqueToken = (byteLen = 32): string => {
  if (byteLen < 16) {
    throw new RangeError(`opaque token byteLen must be >= 16, got ${byteLen}`);
  }
  return randomBytes(byteLen).toString("base64url");
};

// Crockford base32 alphabet, excluding I / L / O / U for readability.
const PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const generatePairingCode = (length = 8): string => {
  if (length < 4 || length > 32) {
    throw new RangeError(`pairing code length must be in [4, 32], got ${length}`);
  }
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    const byte = bytes[i] ?? 0;
    const ch = PAIRING_ALPHABET[byte & 0x1f] ?? "0";
    out += ch;
  }
  return out;
};

export const sha256Hex = (input: string): string =>
  createHash("sha256").update(input, "utf8").digest("hex");

export const constantTimeEqual = (a: string, b: string): boolean => {
  // 長さが違う場合は中身比較せず false (timing 上は length disclosure 程度).
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
};

// Pairing code を正規化する (大文字化 + Crockford 互換の打ち間違い吸収).
// I → 1、L → 1、O → 0、U → V (Crockford spec) として扱う。
export const normalizePairingCode = (raw: string): string => {
  const upper = raw.trim().toUpperCase();
  let out = "";
  for (let i = 0; i < upper.length; i++) {
    const ch = upper.charAt(i);
    switch (ch) {
      case "I":
      case "L":
        out += "1";
        break;
      case "O":
        out += "0";
        break;
      case "U":
        out += "V";
        break;
      case "-":
      case " ":
        // ハイフン / 空白はユーザー入力で混じり得るので無視.
        break;
      default:
        out += ch;
    }
  }
  return out;
};
