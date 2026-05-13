import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  envTokenStore,
  fileTokenStore,
  resolveTokenStore,
  TokenStoreError,
} from "../src/token-store.js";

const userId = "usr_a" as never;
const deviceId = "dev_a" as never;

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "codex-link-host-token-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("fileTokenStore", () => {
  it("returns null when no token saved", async () => {
    const s = fileTokenStore({ basePath: base });
    expect(await s.get(userId, deviceId)).toBeNull();
  });

  it("set / get round-trips", async () => {
    const s = fileTokenStore({ basePath: base });
    await s.set(userId, deviceId, "secret-token");
    expect(await s.get(userId, deviceId)).toBe("secret-token");
  });

  it("writes with 0600 perms (file mode bits)", async () => {
    const s = fileTokenStore({ basePath: base });
    await s.set(userId, deviceId, "x");
    const fs = await import("node:fs/promises");
    const stat = await fs.stat(
      join(base, "tokens", `${userId as string}:${deviceId as string}.token`),
    );
    // mode の下位 9 bit を取り出し.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("clear removes the file, second clear is no-op", async () => {
    const s = fileTokenStore({ basePath: base });
    await s.set(userId, deviceId, "x");
    await s.clear(userId, deviceId);
    await expect(
      readFile(
        join(base, "tokens", `${userId as string}:${deviceId as string}.token`),
        "utf8",
      ),
    ).rejects.toThrow();
    await s.clear(userId, deviceId); // idempotent
  });
});

describe("envTokenStore", () => {
  it("returns the configured token regardless of identifiers", async () => {
    const s = envTokenStore("env-tok");
    expect(await s.get(userId, deviceId)).toBe("env-tok");
  });

  it("is read-only", async () => {
    const s = envTokenStore("env-tok");
    await expect(s.set(userId, deviceId, "x")).rejects.toThrow(TokenStoreError);
    await expect(s.clear(userId, deviceId)).rejects.toThrow(TokenStoreError);
  });
});

describe("resolveTokenStore", () => {
  it("prefers env token when CODEX_LINK_HOST_TOKEN is set", () => {
    const s = resolveTokenStore({
      env: { CODEX_LINK_HOST_TOKEN: "envok" },
      osPlatform: "darwin",
    });
    expect(s.kind).toBe("env");
  });

  it("uses Mac Keychain on darwin", () => {
    const s = resolveTokenStore({
      env: {},
      osPlatform: "darwin",
    });
    expect(s.kind).toBe("keychain");
  });

  it("falls back to file store on linux", () => {
    const s = resolveTokenStore({
      env: { CODEX_LINK_HOME: base },
      osPlatform: "linux",
    });
    expect(s.kind).toBe("file");
  });
});
