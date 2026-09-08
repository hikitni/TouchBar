import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateAdminToken, readAdminToken } from "../src/admin.js";

describe("local admin token", () => {
  it("creates and reuses a private token file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "touchbar-admin-"));
    const filePath = join(directory, "admin-token");

    const first = await loadOrCreateAdminToken(filePath);
    const second = await loadOrCreateAdminToken(filePath);

    expect(first).toBe(second);
    expect(await readAdminToken(filePath)).toBe(first);
    expect((await readFile(filePath, "utf8")).trim()).toBe(first);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });
});
