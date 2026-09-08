import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DeviceStore } from "../src/devices.js";

describe("DeviceStore", () => {
  it("persists only a token hash and authenticates the matching device", async () => {
    const directory = await mkdtemp(join(tmpdir(), "touchbar-devices-"));
    const path = join(directory, "devices.json");
    const store = new DeviceStore({ filePath: path, tokenFactory: () => "secret-token" });
    await store.init();
    await store.issue("phone_1", "Test phone");

    const onDisk = await readFile(path, "utf8");
    expect(onDisk).not.toContain("secret-token");
    expect((await store.authenticate("secret-token", "phone_1"))?.id).toBe("phone_1");
    expect(await store.authenticate("secret-token", "other-device")).toBeUndefined();
    expect(await store.authenticate("wrong-token", "phone_1")).toBeUndefined();
  });
});
