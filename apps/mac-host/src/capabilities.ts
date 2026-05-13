// Host capability の advertise.
//
// Mac Host が `codex --version` 等で取得した情報を CodexLinkEvent
// (host.capabilities.updated) として peer に流す入口. Phase 6 で実 Codex の
// version 取得を組み込む. 現状は config + 環境から組み立てる.

import { spawn } from "node:child_process";

import type { HostId } from "@codex-link/protocol/rendezvous";
import type { HostCapabilities } from "@codex-link/protocol/session";

export interface DetectCapabilitiesInput {
  readonly hostId: HostId;
  readonly hostPlatform: "macos" | "windows" | "linux";
  readonly codexCommand: string;
}

const tryDetectCodexVersion = (
  codexCommand: string,
  timeoutMs = 2_000,
): Promise<string> =>
  new Promise((resolve) => {
    let resolved = false;
    const finish = (v: string): void => {
      if (resolved) return;
      resolved = true;
      resolve(v);
    };
    try {
      const child = spawn(codexCommand, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      child.stdout.on("data", (b: Buffer) => out.push(b));
      child.on("error", () => finish("unknown"));
      child.on("close", () => {
        const text = Buffer.concat(out).toString("utf8").trim();
        finish(text.length > 0 ? text : "unknown");
      });
      setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        finish("unknown");
      }, timeoutMs);
    } catch {
      finish("unknown");
    }
  });

export const detectCapabilities = async (
  input: DetectCapabilitiesInput,
): Promise<HostCapabilities> => {
  const codexVersion = await tryDetectCodexVersion(input.codexCommand);
  return {
    hostId: input.hostId,
    platform: input.hostPlatform,
    codexVersion,
    supportsApprovals: true,
  };
};
