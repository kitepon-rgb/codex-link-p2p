import { describe, expect, it } from "vitest";

import {
  constantTimeEqual,
  generateDeviceId,
  generateHostId,
  generateOpaqueToken,
  generatePairingCode,
  generateUserId,
  normalizePairingCode,
  sha256Hex,
} from "../src/ids.js";

describe("ID generators", () => {
  it("are unique across many invocations", () => {
    const userIds = new Set<string>();
    const deviceIds = new Set<string>();
    const hostIds = new Set<string>();
    for (let i = 0; i < 200; i++) {
      userIds.add(generateUserId() as string);
      deviceIds.add(generateDeviceId() as string);
      hostIds.add(generateHostId() as string);
    }
    expect(userIds.size).toBe(200);
    expect(deviceIds.size).toBe(200);
    expect(hostIds.size).toBe(200);
  });

  it("carry recognizable prefixes for debugging", () => {
    expect(generateUserId() as string).toMatch(/^usr_[0-9a-f-]{36}$/);
    expect(generateDeviceId() as string).toMatch(/^dev_[0-9a-f-]{36}$/);
    expect(generateHostId() as string).toMatch(/^hst_[0-9a-f-]{36}$/);
  });
});

describe("generateOpaqueToken", () => {
  it("returns base64url strings of expected length", () => {
    const t = generateOpaqueToken(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes → 43 chars of base64url (no padding).
    expect(t.length).toBe(43);
  });

  it("rejects tiny token sizes", () => {
    expect(() => generateOpaqueToken(8)).toThrow(RangeError);
  });

  it("emits distinct values per call", () => {
    const set = new Set<string>();
    for (let i = 0; i < 50; i++) set.add(generateOpaqueToken());
    expect(set.size).toBe(50);
  });
});

describe("generatePairingCode", () => {
  it("yields a string using only Crockford base32 alphabet (no I/L/O/U)", () => {
    for (let i = 0; i < 100; i++) {
      const code = generatePairingCode();
      expect(code.length).toBe(8);
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    }
  });

  it("respects custom length within bounds", () => {
    expect(generatePairingCode(6).length).toBe(6);
    expect(generatePairingCode(12).length).toBe(12);
  });

  it("rejects out-of-range lengths", () => {
    expect(() => generatePairingCode(3)).toThrow(RangeError);
    expect(() => generatePairingCode(33)).toThrow(RangeError);
  });
});

describe("normalizePairingCode", () => {
  it("uppercases the input", () => {
    expect(normalizePairingCode("abc12345")).toBe("ABC12345");
  });

  it("maps I/L → 1, O → 0, U → V (case-insensitive)", () => {
    expect(normalizePairingCode("IL0OUu")).toBe("1100VV");
  });

  it("strips whitespace and dashes", () => {
    expect(normalizePairingCode(" AB-CD 1234 ")).toBe("ABCD1234");
  });
});

describe("sha256Hex", () => {
  it("is deterministic for identical inputs", () => {
    expect(sha256Hex("hello")).toBe(sha256Hex("hello"));
  });

  it("matches a known vector", () => {
    // sha256("abc") in hex
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("differs for different inputs (sanity)", () => {
    expect(sha256Hex("hello")).not.toBe(sha256Hex("hellp"));
  });
});

describe("constantTimeEqual", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
  });

  it("returns false for different content of same length", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });

  it("returns false for different lengths without comparing content", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});
