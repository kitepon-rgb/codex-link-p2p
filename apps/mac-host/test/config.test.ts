import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_RELAY_URL,
  HostConfigError,
  loadHostConfig,
  parseHostConfig,
  resolveHostConfigPath,
  resolveHostHome,
  wsRelayUrl,
  writeHostConfig,
  type HostConfig,
} from "../src/config.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "codex-link-host-config-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const sampleConfig: HostConfig = {
  userId: "usr_abc" as never,
  deviceId: "dev_xyz" as never,
  hostId: "hst_mac" as never,
  displayName: "kite Mac",
  hostPlatform: "macos",
  relayUrl: DEFAULT_RELAY_URL,
  codexCommand: "codex",
};

describe("resolveHostHome / resolveHostConfigPath", () => {
  it("CODEX_LINK_HOME overrides default", () => {
    const home = resolveHostHome({ CODEX_LINK_HOME: "/tmp/custom" });
    expect(home).toBe("/tmp/custom");
    expect(resolveHostConfigPath({ CODEX_LINK_HOME: "/tmp/custom" })).toBe(
      "/tmp/custom/host.json",
    );
  });

  it("falls back to $HOME/.codex-link-p2p when env unset", () => {
    const home = resolveHostHome({});
    expect(home.endsWith("/.codex-link-p2p")).toBe(true);
  });
});

describe("parseHostConfig", () => {
  it("rejects non-object", () => {
    expect(() => parseHostConfig("nope")).toThrow(HostConfigError);
    expect(() => parseHostConfig(null)).toThrow(HostConfigError);
    expect(() => parseHostConfig([])).toThrow(HostConfigError);
  });

  it("fills defaults for relayUrl and codexCommand", () => {
    const cfg = parseHostConfig({
      userId: "usr_a",
      deviceId: "dev_a",
      hostId: "hst_a",
      displayName: "M",
      hostPlatform: "macos",
    });
    expect(cfg.relayUrl).toBe(DEFAULT_RELAY_URL);
    expect(cfg.codexCommand).toBe("codex");
  });

  it("rejects invalid hostPlatform", () => {
    expect(() =>
      parseHostConfig({
        userId: "u",
        deviceId: "d",
        hostId: "h",
        displayName: "n",
        hostPlatform: "ios",
      }),
    ).toThrow(/hostPlatform/);
  });

  it("rejects empty required strings", () => {
    expect(() =>
      parseHostConfig({
        userId: "",
        deviceId: "d",
        hostId: "h",
        displayName: "n",
        hostPlatform: "macos",
      }),
    ).toThrow(/userId/);
  });
});

describe("writeHostConfig + loadHostConfig", () => {
  it("round-trips through disk with mode 600 perms", async () => {
    const path = join(tempDir, "host.json");
    await writeHostConfig(path, sampleConfig);
    const loaded = await loadHostConfig(path);
    expect(loaded).toEqual(sampleConfig);
  });

  it("loadHostConfig throws helpful error when file missing", async () => {
    const path = join(tempDir, "missing.json");
    await expect(loadHostConfig(path)).rejects.toThrow(
      /host\.json not found/,
    );
  });

  it("loadHostConfig throws on invalid JSON", async () => {
    const path = join(tempDir, "bad.json");
    const fs = await import("node:fs/promises");
    await fs.writeFile(path, "not valid", "utf8");
    await expect(loadHostConfig(path)).rejects.toThrow(/invalid JSON/);
  });

  it("writeHostConfig creates parent directory", async () => {
    const nested = join(tempDir, "nested", "deeper");
    const path = join(nested, "host.json");
    await writeHostConfig(path, sampleConfig);
    const loaded = await loadHostConfig(path);
    expect(loaded.hostId).toBe(sampleConfig.hostId);
  });

  it("host.json on disk does not contain session token field", async () => {
    const path = join(tempDir, "host.json");
    await writeHostConfig(path, sampleConfig);
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(path, "utf8");
    expect(raw).not.toMatch(/sessionToken/);
    expect(raw).not.toMatch(/token/);
  });
});

describe("wsRelayUrl", () => {
  it("https → wss, http → ws", () => {
    expect(wsRelayUrl("https://relay.example")).toBe("wss://relay.example");
    expect(wsRelayUrl("http://127.0.0.1:3000")).toBe("ws://127.0.0.1:3000");
  });

  it("rejects unknown schemes", () => {
    expect(() => wsRelayUrl("ftp://relay.example")).toThrow(HostConfigError);
  });
});
