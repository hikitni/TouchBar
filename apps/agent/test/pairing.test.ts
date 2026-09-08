import { describe, expect, it } from "vitest";
import { PairingCodeManager } from "../src/pairing.js";

describe("PairingCodeManager", () => {
  it("accepts a six-digit code once and enforces a failure rate limit", () => {
    let now = 0;
    const pairing = new PairingCodeManager({
      ttlSeconds: 60,
      maxAttempts: 2,
      attemptWindowMs: 1_000,
      now: () => now,
      generateCode: () => "123456",
    });

    expect(pairing.verify("not-a-code", "client-a")).toEqual({ ok: false, reason: "invalid" });
    expect(pairing.verify("000000", "client-a")).toEqual({ ok: false, reason: "invalid" });
    expect(pairing.verify("123456", "client-a")).toEqual({ ok: false, reason: "rate_limited" });

    now = 1_001;
    expect(pairing.verify("123456", "client-a")).toEqual({ ok: true });
    expect(pairing.verify("123456", "client-b")).toEqual({ ok: false, reason: "expired" });
  });
});
