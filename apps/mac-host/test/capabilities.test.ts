import { describe, expect, it } from "vitest";

import { asHostId } from "@codex-link/protocol/rendezvous";

import { detectCapabilities } from "../src/capabilities.js";

describe("detectCapabilities", () => {
  it("returns 'unknown' codexVersion when the command does not exist", async () => {
    const caps = await detectCapabilities({
      hostId: asHostId("hst_test"),
      hostPlatform: "macos",
      codexCommand: "definitely-not-a-real-binary-xyzzy",
    });
    expect(caps.codexVersion).toBe("unknown");
    expect(caps.platform).toBe("macos");
    expect(caps.supportsApprovals).toBe(true);
  });

  it("captures stdout of a working command (echo as a stand-in)", async () => {
    const caps = await detectCapabilities({
      hostId: asHostId("hst_test"),
      hostPlatform: "linux",
      codexCommand: "/bin/echo",
    });
    // /bin/echo --version の出力は環境依存だが "unknown" にならず何かしらの
    // 文字列を返す.
    expect(caps.codexVersion.length).toBeGreaterThan(0);
  });
});
