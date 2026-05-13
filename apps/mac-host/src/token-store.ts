// device session token の保存先抽象化.
//
// MVP の対応:
// - MacKeychainTokenStore: macOS の `security` CLI を呼ぶ. service =
//   `codex-link-p2p`, account = `${userId}:${deviceId}`.
// - FileTokenStore: $CODEX_LINK_HOME/token (mode 0600). dev / CI / Linux 向け.
//   本番 Mac 配布では使わない (Keychain 推奨).
// - EnvTokenStore: 環境変数 CODEX_LINK_HOST_TOKEN. 一時的な実行に便利.
//
// resolveTokenStore: 環境を見て一番安全なものを選ぶ.

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

import type { DeviceId, UserId } from "@codex-link/protocol/rendezvous";

export interface TokenStore {
  readonly kind: "keychain" | "file" | "env";
  get(userId: UserId, deviceId: DeviceId): Promise<string | null>;
  set(userId: UserId, deviceId: DeviceId, token: string): Promise<void>;
  clear(userId: UserId, deviceId: DeviceId): Promise<void>;
}

export class TokenStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenStoreError";
  }
}

const accountFor = (userId: UserId, deviceId: DeviceId): string =>
  `${userId as string}:${deviceId as string}`;

// ===== Mac Keychain =====
//
// `security` CLI 経由. ユーザー Keychain (login.keychain) に generic password を
// 書く. node-keytar 等のネイティブ依存を避けるため stdlib のみで実装.

const SECURITY_BIN = "/usr/bin/security";
const KEYCHAIN_SERVICE = "codex-link-p2p";

const runSecurity = (
  args: readonly string[],
  input?: string,
): Promise<{ status: number; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(SECURITY_BIN, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        status: code ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });

export const macKeychainTokenStore = (): TokenStore => ({
  kind: "keychain",
  async get(userId, deviceId) {
    const account = accountFor(userId, deviceId);
    const r = await runSecurity([
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      account,
      "-w",
    ]);
    if (r.status === 44 /* errSecItemNotFound */ || r.status !== 0) {
      // 0 以外でも「無いだけ」なら null を返す. それ以外の真のエラーは
      // stderr に出るが、MVP では一律 null. 必要なら別 path で診断.
      return null;
    }
    return r.stdout.replace(/\r?\n$/, "");
  },
  async set(userId, deviceId, token) {
    const account = accountFor(userId, deviceId);
    // -U で上書き許容. -w で password 指定. (CLI 引数経由で見えると ps で
    // 漏れるので、本来は stdin 経由が望ましいが macOS の security CLI は
    // stdin password を直接サポートしないため引数経由を許容する MVP)
    const r = await runSecurity([
      "add-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      account,
      "-w",
      token,
      "-U",
    ]);
    if (r.status !== 0) {
      throw new TokenStoreError(
        `security add-generic-password failed (status ${r.status}): ${r.stderr}`,
      );
    }
  },
  async clear(userId, deviceId) {
    const account = accountFor(userId, deviceId);
    await runSecurity([
      "delete-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      account,
    ]);
    // 無くてもエラーにしない (idempotent clear).
  },
});

// ===== File token store =====

export interface FileTokenStoreOptions {
  readonly basePath: string;
}

const fileFor = (basePath: string, userId: UserId, deviceId: DeviceId): string =>
  join(basePath, "tokens", `${accountFor(userId, deviceId)}.token`);

export const fileTokenStore = (
  options: FileTokenStoreOptions,
): TokenStore => ({
  kind: "file",
  async get(userId, deviceId) {
    try {
      const data = await readFile(
        fileFor(options.basePath, userId, deviceId),
        "utf8",
      );
      const trimmed = data.replace(/\r?\n$/, "");
      return trimmed.length > 0 ? trimmed : null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new TokenStoreError(`failed to read token file: ${(e as Error).message}`);
    }
  },
  async set(userId, deviceId, token) {
    const path = fileFor(options.basePath, userId, deviceId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, token + "\n", { encoding: "utf8", mode: 0o600 });
  },
  async clear(userId, deviceId) {
    try {
      await unlink(fileFor(options.basePath, userId, deviceId));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  },
});

// ===== Env token store =====
//
// CODEX_LINK_HOST_TOKEN を 1 つの token として返す read-only store.

export const envTokenStore = (token: string): TokenStore => ({
  kind: "env",
  async get() {
    return token;
  },
  async set() {
    throw new TokenStoreError("envTokenStore is read-only");
  },
  async clear() {
    throw new TokenStoreError("envTokenStore is read-only");
  },
});

// ===== Resolver =====
//
// env CODEX_LINK_HOST_TOKEN があればそれを優先 (CI / 一時起動).
// それ以外で macOS なら Keychain、それ以外なら file store.

export interface ResolveTokenStoreInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly osPlatform?: NodeJS.Platform;
  readonly fallbackBasePath?: string;
}

export const resolveTokenStore = ({
  env,
  osPlatform = platform(),
  fallbackBasePath,
}: ResolveTokenStoreInput): TokenStore => {
  const fromEnv = env["CODEX_LINK_HOST_TOKEN"];
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return envTokenStore(fromEnv);
  }
  const fileBase =
    fallbackBasePath ??
    env["CODEX_LINK_HOME"] ??
    join(homedir(), ".codex-link-p2p");
  // 明示的な kind 指定 (test / CI / Linux Docker などで Keychain を回避するため).
  const explicit = env["CODEX_LINK_TOKEN_STORE"];
  if (explicit === "file") return fileTokenStore({ basePath: fileBase });
  if (explicit === "keychain") return macKeychainTokenStore();
  // env なら CODEX_LINK_HOST_TOKEN が必須 — 上で処理済みなのでここに来ない.

  if (osPlatform === "darwin") {
    return macKeychainTokenStore();
  }
  return fileTokenStore({ basePath: fileBase });
};
