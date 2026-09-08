import { randomInt } from "node:crypto";

export type PairingVerification =
  | { ok: true }
  | { ok: false; reason: "invalid" | "expired" | "rate_limited" };

interface AttemptWindow {
  count: number;
  resetAt: number;
}

export interface PairingCodeManagerOptions {
  ttlSeconds: number;
  maxAttempts?: number;
  attemptWindowMs?: number;
  now?: () => number;
  generateCode?: () => string;
}

/** Holds one short-lived, single-use pairing secret and per-client failure limits. */
export class PairingCodeManager {
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly attemptWindowMs: number;
  private readonly now: () => number;
  private readonly generateCode: () => string;
  private readonly attempts = new Map<string, AttemptWindow>();
  private code = "";
  private expiresAt = 0;

  public constructor(options: PairingCodeManagerOptions) {
    this.ttlMs = options.ttlSeconds * 1_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.attemptWindowMs = options.attemptWindowMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.generateCode = options.generateCode ?? (() => randomInt(0, 1_000_000).toString().padStart(6, "0"));
    this.rotate();
  }

  public rotate(): { code: string; expiresAt: Date } {
    const previous = this.code;
    let next = this.generateCode();
    // A random collision must not make a just-consumed secret valid again.
    for (let attempt = 0; next === previous && attempt < 8; attempt += 1) {
      next = this.generateCode();
    }
    if (next === previous) {
      next = ((Number.parseInt(previous || "0", 10) + 1) % 1_000_000).toString().padStart(6, "0");
    }
    this.code = next;
    this.expiresAt = this.now() + this.ttlMs;
    return this.current();
  }

  public current(): { code: string; expiresAt: Date } {
    return { code: this.code, expiresAt: new Date(this.expiresAt) };
  }

  public verify(candidate: unknown, clientKey: string): PairingVerification {
    const now = this.now();
    const existing = this.attempts.get(clientKey);
    if (existing && now < existing.resetAt && existing.count >= this.maxAttempts) {
      return { ok: false, reason: "rate_limited" };
    }
    if (existing && now >= existing.resetAt) {
      this.attempts.delete(clientKey);
    }

    if (now >= this.expiresAt) {
      this.recordFailure(clientKey, now);
      return { ok: false, reason: "expired" };
    }
    if (typeof candidate !== "string" || !/^\d{6}$/.test(candidate) || candidate !== this.code) {
      this.recordFailure(clientKey, now);
      return { ok: false, reason: "invalid" };
    }

    this.attempts.delete(clientKey);
    // Consume first; the caller may immediately rotate to make a fresh code available.
    this.expiresAt = now;
    return { ok: true };
  }

  private recordFailure(clientKey: string, now: number): void {
    const current = this.attempts.get(clientKey);
    if (!current || now >= current.resetAt) {
      this.attempts.set(clientKey, { count: 1, resetAt: now + this.attemptWindowMs });
      return;
    }
    current.count += 1;
  }
}
