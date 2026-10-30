import { describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";
const { base32Decode, base32Encode, openSecret, sealSecret, totpCode, verifyTotp } = await import("@/lib/server/totp");

// RFC 6238 test key "12345678901234567890" (SHA-1).
const RFC_KEY = base32Encode(Buffer.from("12345678901234567890"));

describe("two-step sign-in codes (TOTP)", () => {
  it("matches the RFC 6238 test vectors", () => {
    expect(RFC_KEY).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(RFC_KEY).toString()).toBe("12345678901234567890");
    expect(totpCode(RFC_KEY, Math.floor(59 / 30))).toBe("287082");
    expect(totpCode(RFC_KEY, Math.floor(1111111109 / 30))).toBe("081804");
  });

  it("accepts one step of clock drift, refuses replays and wrong codes", () => {
    const now = 1111111109 * 1000;
    const step = Math.floor(1111111109 / 30);
    expect(verifyTotp(RFC_KEY, "081804", null, now)).toBe(step);
    expect(verifyTotp(RFC_KEY, totpCode(RFC_KEY, step - 1), null, now)).toBe(step - 1);
    expect(verifyTotp(RFC_KEY, "081804", step, now)).toBeNull();
    expect(verifyTotp(RFC_KEY, "000000", null, now)).toBeNull();
    expect(verifyTotp(RFC_KEY, "12ab56", null, now)).toBeNull();
  });

  it("stores the key encrypted and detects tampering", () => {
    const sealed = sealSecret(RFC_KEY);
    expect(sealed).not.toContain(RFC_KEY);
    expect(openSecret(sealed)).toBe(RFC_KEY);
    const parts = sealed.split(".");
    parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith("A") ? "BB" : "AA");
    expect(() => openSecret(parts.join("."))).toThrow();
  });
});
