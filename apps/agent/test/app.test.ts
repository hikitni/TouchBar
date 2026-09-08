import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { touchBarConfigSchema, type CapabilityMap, type TouchBarAction } from "@touchbar/protocol";
import { describe, expect, it } from "vitest";
import { createAgentApp, resolveDefaultWebRoot } from "../src/app.js";
import { DeviceStore } from "../src/devices.js";
import type { AgentExecutor, AudioStatus, ExecutionResult } from "../src/executors.js";
import { PairingCodeManager } from "../src/pairing.js";
import { TestSystemMonitor } from "./support/ai-usage.js";

class FakeExecutor implements AgentExecutor {
  public calls: Array<{ action: TouchBarAction; value: number | undefined }> = [];
  public async getCapabilities(): Promise<CapabilityMap> {
    return { media: true, volume: true, brightness: true, system: true, launchApp: true, openUrl: true, keystroke: true, appShortcut: true, bttTrigger: false };
  }
  public async execute(action: TouchBarAction, value?: number): Promise<ExecutionResult> {
    this.calls.push({ action, value });
    return { ok: true, outcome: "verified", code: "ok", message: "done" };
  }
  public async getAudioStatus(): Promise<AudioStatus> {
    return { volume: 42, muted: false };
  }
}

const config = touchBarConfigSchema.parse({
  version: 1,
  server: { port: 8787, pairingTtlSeconds: 600 },
  profiles: [{
    id: "main",
    title: "Main",
    items: [{ id: "volume", type: "slider", actionId: "volume_set", statusKey: "volume", min: 0, max: 100, step: 5 }],
  }],
  actions: { volume_set: { type: "volume", command: "set" } },
});

describe("HTTP API", () => {
  it("resolves the bundled web UI independently of the process working directory", () => {
    const expected = fileURLToPath(new URL("../../web/dist", import.meta.url));
    expect(resolveDefaultWebRoot()).toBe(expected);
  });

  it("pairs once, protects API routes, and validates configured slider values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "touchbar-api-"));
    const executor = new FakeExecutor();
    const agent = await createAgentApp({
      config,
      systemMonitor: new TestSystemMonitor(),
      executor,
      deviceStore: new DeviceStore({ filePath: join(directory, "devices.json"), tokenFactory: () => "paired-token" }),
      pairing: new PairingCodeManager({ ttlSeconds: 600, generateCode: () => "123456" }),
      adminToken: "local-admin-token-with-sufficient-length",
      webRoot: false,
    });
    try {
      expect((await agent.app.inject({ method: "GET", url: "/api/bootstrap" })).statusCode).toBe(401);
      const pairing = await agent.app.inject({ method: "POST", url: "/api/pair", payload: { code: "123456", deviceName: "Phone" } });
      expect(pairing.statusCode).toBe(201);
      const token = pairing.json<{ token: string }>().token;
      expect(token).toBe("paired-token");
      expect(pairing.json<{ deviceId: string }>().deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect((await agent.deviceStore.list())[0]).toMatchObject({ name: "Phone" });
      expect((await agent.app.inject({ method: "POST", url: "/api/pair", payload: { code: "123456", deviceName: "Second phone" } })).statusCode).toBe(401);

      const headers = { authorization: `Bearer ${token}` };
      expect((await agent.app.inject({ method: "GET", url: "/api/bootstrap", headers })).json()).toMatchObject({
        tabs: [{ id: "monitor" }, { id: "control" }, { id: "shortcuts" }],
        profiles: [{ id: "control" }],
        actionCapabilities: { volume_set: true },
        status: { volume: 42 },
      });
      expect((await agent.app.inject({ method: "POST", url: "/api/actions/volume_set/execute", headers, payload: { value: 43 } })).statusCode).toBe(400);
      const action = await agent.app.inject({ method: "POST", url: "/api/actions/volume_set/execute", headers, payload: { requestId: "r1", value: 45 } });
      expect(action.statusCode).toBe(200);
      expect(action.json()).toMatchObject({ requestId: "r1", ok: true, outcome: "verified", code: "ok" });
      expect(executor.calls).toEqual([{ action: { type: "volume", command: "set" }, value: 45 }]);

      expect((await agent.app.inject({ method: "GET", url: "/api/admin/devices" })).statusCode).toBe(401);
      const adminHeaders = { "x-touchbar-admin": "local-admin-token-with-sufficient-length" };
      expect((await agent.app.inject({ method: "GET", url: "/api/admin/devices", headers: adminHeaders })).json()).toMatchObject([{ name: "Phone" }]);
      expect((await agent.app.inject({ method: "DELETE", url: `/api/admin/devices/${pairing.json<{ deviceId: string }>().deviceId}`, headers: adminHeaders })).statusCode).toBe(204);
      expect((await agent.app.inject({ method: "GET", url: "/api/bootstrap", headers })).statusCode).toBe(401);
    } finally {
      await agent.close();
    }
  });
});
