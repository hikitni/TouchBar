import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { touchBarConfigSchema, type CapabilityMap, type TouchBarAction } from "@touchbar/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createAgentApp, type TouchBarAgent } from "../src/app.js";
import { DeviceStore } from "../src/devices.js";
import type { AgentExecutor, AudioStatus, ExecutionResult } from "../src/executors.js";
import { PairingCodeManager } from "../src/pairing.js";
import { TestSystemMonitor } from "./support/ai-usage.js";

class FakeExecutor implements AgentExecutor {
  async getCapabilities(): Promise<CapabilityMap> {
    return { media: true, volume: true, brightness: true, system: true, launchApp: true, openUrl: true, keystroke: true, appShortcut: true, bttTrigger: false };
  }
  async execute(_action: TouchBarAction, _value?: number): Promise<ExecutionResult> {
    return { ok: true, outcome: "verified", code: "ok", message: "done" };
  }
  async getAudioStatus(): Promise<AudioStatus> {
    return { volume: 33, muted: false };
  }
}

const config = touchBarConfigSchema.parse({
  version: 1,
  server: { port: 8787, pairingTtlSeconds: 600 },
  profiles: [{ id: "main", title: "Main", items: [{ id: "play", type: "button", actionId: "play" }] }],
  actions: { play: { type: "media", command: "playPause" } },
});

const agents: TouchBarAgent[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
});

async function createTestAgent(authenticationTimeoutMs = 5_000): Promise<{ agent: TouchBarAgent; wsUrl: string }> {
  const directory = await mkdtemp(join(tmpdir(), "touchbar-ws-"));
  const agent = await createAgentApp({
    config,
    systemMonitor: new TestSystemMonitor(),
    executor: new FakeExecutor(),
    deviceStore: new DeviceStore({ filePath: join(directory, "devices.json"), tokenFactory: () => "websocket-token" }),
    pairing: new PairingCodeManager({ ttlSeconds: 600, generateCode: () => "123456" }),
    adminToken: "local-admin-token-with-sufficient-length",
    authenticationTimeoutMs,
    webRoot: false,
  });
  agents.push(agent);
  const address = await agent.app.listen({ host: "127.0.0.1", port: 0 });
  return { agent, wsUrl: `${address.replace(/^http/, "ws")}/ws` };
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForMessages(socket: WebSocket, count: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const messages: unknown[] = [];
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket messages")), 2_000);
    socket.on("message", (raw) => {
      messages.push(JSON.parse(raw.toString()) as unknown);
      if (messages.length >= count) {
        clearTimeout(timeout);
        resolve(messages);
      }
    });
  });
}

describe("WebSocket authentication", () => {
  it("authenticates as the first message and receives a snapshot", async () => {
    const { agent, wsUrl } = await createTestAgent();
    const pairing = await agent.app.inject({ method: "POST", url: "/api/pair", payload: { code: "123456", deviceName: "Tablet" } });
    const credentials = pairing.json<{ deviceId: string; token: string }>();
    const socket = new WebSocket(wsUrl);
    await waitForOpen(socket);
    const messagesPromise = waitForMessages(socket, 2);
    socket.send(JSON.stringify({ type: "auth", ...credentials }));

    const messages = await messagesPromise as Array<{ type: string; payload?: { status?: { volume?: number }; actionCapabilities?: Record<string, boolean> } }>;
    expect(messages[0]).toMatchObject({ type: "authResult", ok: true });
    expect(messages[1]).toMatchObject({ type: "snapshot", payload: { status: { volume: 33 }, actionCapabilities: { play: true } } });
    socket.close();
  });

  it("closes an authenticated connection when its device is revoked", async () => {
    const { agent, wsUrl } = await createTestAgent();
    const pairing = await agent.app.inject({ method: "POST", url: "/api/pair", payload: { code: "123456", deviceName: "Tablet" } });
    const credentials = pairing.json<{ deviceId: string; token: string }>();
    const socket = new WebSocket(wsUrl);
    await waitForOpen(socket);
    const messagesPromise = waitForMessages(socket, 2);
    socket.send(JSON.stringify({ type: "auth", ...credentials }));
    await messagesPromise;

    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    const revoke = await agent.app.inject({
      method: "DELETE",
      url: `/api/admin/devices/${credentials.deviceId}`,
      headers: { "x-touchbar-admin": "local-admin-token-with-sufficient-length" },
    });

    expect(revoke.statusCode).toBe(204);
    await expect(closed).resolves.toEqual({ code: 1008, reason: "Device revoked" });
    expect((await agent.app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { authorization: `Bearer ${credentials.token}` },
    })).statusCode).toBe(401);
  });

  it("closes a connection that does not authenticate in time", async () => {
    const { wsUrl } = await createTestAgent(40);
    const socket = new WebSocket(wsUrl);
    await waitForOpen(socket);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    await expect(closed).resolves.toEqual({ code: 1008, reason: "认证超时" });
  });
});
