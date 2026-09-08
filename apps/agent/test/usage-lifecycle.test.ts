import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { touchBarConfigSchema, type AiDailyUsage, type CapabilityMap, type TouchBarAction } from "@touchbar/protocol";
import { describe, expect, it } from "vitest";
import { createAgentApp } from "../src/app.js";
import { CcusageDailyUsageCollector, type CcusageRunner } from "../src/ai-usage.js";
import { DeviceStore } from "../src/devices.js";
import type { AgentExecutor, AudioStatus, ExecutionResult } from "../src/executors.js";
import { PairingCodeManager } from "../src/pairing.js";
import { SystemMonitor, type AgentRuntimeStatus } from "../src/system-monitor.js";
import { TestSystemMonitor } from "./support/ai-usage.js";

const emptyReport = {
  daily: [],
  totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, totalCost: 0 },
};
const config = touchBarConfigSchema.parse({
  version: 1, profiles: [{ id: "main", title: "Main", items: [{ id: "play", type: "button", actionId: "play" }] }],
  actions: { play: { type: "media", command: "playPause" } },
});
class FakeExecutor implements AgentExecutor {
  public calls = 0;
  async getCapabilities(): Promise<CapabilityMap> {
    return { media: true, volume: true, brightness: true, system: true, launchApp: true, openUrl: true, keystroke: true, appShortcut: true, bttTrigger: false };
  }
  async execute(_action: TouchBarAction): Promise<ExecutionResult> {
    this.calls += 1;
    return { ok: true, outcome: "accepted", code: "ok", message: "测试指令已发送" };
  }
  async getAudioStatus(): Promise<AudioStatus> { return { volume: 42, muted: false }; }
}
class UsageTestMonitor extends SystemMonitor {
  private readonly fixture = new TestSystemMonitor();
  public override async snapshot(runtime: AgentRuntimeStatus) {
    return { ...await this.fixture.snapshot(runtime), aiDailyUsage: this.getAiUsage() };
  }
}
async function makeAgent(runner: CcusageRunner, now = () => new Date("2026-09-08T10:00:00+08:00")) {
  const directory = await mkdtemp(join(tmpdir(), "touchbar-usage-lifecycle-"));
  const collector = new CcusageDailyUsageCollector({ runner, now, timezone: () => "Asia/Shanghai" });
  const executor = new FakeExecutor();
  const agent = await createAgentApp({
    config, executor, systemMonitor: new UsageTestMonitor({ aiUsageCollector: collector }),
    deviceStore: new DeviceStore({ filePath: join(directory, "devices.json") }),
    pairing: new PairingCodeManager({ ttlSeconds: 600, generateCode: () => "123456" }),
    monitorIntervalMs: 20, webRoot: false,
  });
  const address = await agent.app.listen({ host: "127.0.0.1", port: 0 });
  const pair = await agent.app.inject({ method: "POST", url: "/api/pair", payload: { code: "123456", deviceName: "Test" } });
  const credentials = pair.json<{ deviceId: string; token: string }>();
  return { agent, collector, executor, credentials, wsUrl: address.replace(/^http/, "ws") + "/ws", headers: { authorization: `Bearer ${credentials.token}` } };
}
async function connect(url: string, credentials: { deviceId: string; token: string }): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out connecting")), 2000);
    socket.on("error", reject);
    socket.on("open", () => socket.send(JSON.stringify({ type: "auth", ...credentials })));
    socket.on("message", raw => {
      if ((JSON.parse(raw.toString()) as { type: string }).type === "snapshot") { clearTimeout(timeout); resolve(); }
    });
  });
  return socket;
}
async function disconnect(socket: WebSocket) {
  await new Promise<void>(resolve => { socket.once("close", () => resolve()); socket.close(); });
}

describe("AI usage lifecycle integration", () => {
  it("auth demand and clients share collection, idle clients do not poll, and shutdown closes the runner", async () => {
    let runs = 0;
    let closed = false;
    let now = new Date("2026-09-08T10:00:00+08:00");
    const runner: CcusageRunner = { run: async () => { runs += 1; return emptyReport; }, close: async () => { closed = true; } };
    const { agent, credentials, wsUrl, headers } = await makeAgent(runner, () => now);
    const sockets: WebSocket[] = [];
    try {
      await delay(70);
      expect(runs).toBe(0);
      expect((await agent.app.inject({ method: "GET", url: "/api/bootstrap" })).statusCode).toBe(401);
      expect(runs).toBe(0);
      const bootstrap = await agent.app.inject({ method: "GET", url: "/api/bootstrap", headers });
      expect(bootstrap.statusCode).toBe(200);
      expect(runs).toBe(1);
      const current = (await agent.app.inject({ method: "GET", url: "/api/status", headers })).json<{ system: { aiDailyUsage: AiDailyUsage } }>();
      expect(current.system.aiDailyUsage).toMatchObject({ status: "ready", collector: "ccusage", totals: { totalTokens: 0 } });
      sockets.push(await connect(wsUrl, credentials), await connect(wsUrl, credentials));
      await delay(80);
      expect(runs).toBe(1);
      for (const socket of sockets.splice(0)) await disconnect(socket);
      await delay(30);
      now = new Date(now.getTime() + 600001);
      await delay(90);
      expect(runs).toBe(1);
      sockets.push(await connect(wsUrl, credentials));
      expect(runs).toBe(2);
      await delay(70);
      expect(runs).toBe(2);
    } finally {
      for (const socket of sockets) await disconnect(socket);
      await agent.close();
    }
    expect(closed).toBe(true);
  });

  it("a pending CLI never blocks bootstrap, status, or configured actions", async () => {
    let finish!: (report: unknown) => void;
    let runs = 0;
    const waiting = new Promise<unknown>(resolve => { finish = resolve; });
    const runner: CcusageRunner = { run: () => { runs += 1; return waiting; }, close: async () => { finish(emptyReport); } };
    const { agent, executor, headers } = await makeAgent(runner);
    try {
      const bootstrap = await agent.app.inject({ method: "GET", url: "/api/bootstrap", headers });
      expect(bootstrap.statusCode).toBe(200);
      expect(bootstrap.json()).toMatchObject({ status: { system: { aiDailyUsage: { status: "loading", totals: null }, codexDailyUsage: null } } });
      const action = await agent.app.inject({ method: "POST", url: "/api/actions/play/execute", headers, payload: {} });
      expect(action.json()).toMatchObject({ ok: true, outcome: "accepted" });
      expect(executor.calls).toBe(1);
      const status = await agent.app.inject({ method: "GET", url: "/api/status", headers });
      expect(status.json()).toMatchObject({ system: { aiDailyUsage: { status: "loading", totals: null } } });
      expect(runs).toBe(1);
      finish(emptyReport);
    } finally { await agent.close(); }
  });
});
