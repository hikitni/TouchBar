import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import type { RawData, WebSocket } from "ws";
import type {
  ActionAvailability,
  ActionOutcome,
  ActionResult,
  BootstrapResponse,
  CapabilityMap,
  DashboardTab,
  DeviceRecord,
  Profile,
  TouchBarAction,
  TouchBarConfig,
} from "@touchbar/protocol";
import { pairRequestSchema } from "@touchbar/protocol";
import { DeviceStore } from "./devices.js";
import { MacActionExecutor, type AgentExecutor } from "./executors.js";
import { PairingCodeManager } from "./pairing.js";
import { StatusService } from "./status.js";
import { SystemMonitor } from "./system-monitor.js";

const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function resolveDefaultWebRoot(moduleUrl = import.meta.url): string {
  return fileURLToPath(new URL("../../web/dist", moduleUrl));
}

export interface CreateAgentAppOptions {
  config: TouchBarConfig;
  version?: string;
  deviceStore?: DeviceStore;
  executor?: AgentExecutor;
  pairing?: PairingCodeManager;
  webRoot?: string | false;
  authenticationTimeoutMs?: number;
  adminToken?: string;
  onPairingCodeRotated?: (pairing: { code: string; expiresAt: Date }) => void;
  systemMonitor?: SystemMonitor;
  monitorIntervalMs?: number | false;
}

export interface TouchBarAgent {
  app: FastifyInstance;
  pairing: PairingCodeManager;
  deviceStore: DeviceStore;
  executor: AgentExecutor;
  close(): Promise<void>;
}

export async function createAgentApp(options: CreateAgentAppOptions): Promise<TouchBarAgent> {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  const version = options.version ?? "1.3.0";
  const deviceStore = options.deviceStore ?? new DeviceStore();
  const executor = options.executor ?? new MacActionExecutor({ applications: options.config.applications });
  const pairing = options.pairing ?? new PairingCodeManager({ ttlSeconds: options.config.server.pairingTtlSeconds });
  const clients = new Map<WebSocket, string>();
  const startedAt = Date.now();
  let actionCount = 0;
  const status = new StatusService(
    executor,
    options.systemMonitor ?? new SystemMonitor(),
    () => ({
      agentUptimeSeconds: Math.round((Date.now() - startedAt) / 1_000),
      connectedClients: clients.size,
      actionCount,
    }),
  );
  const authenticationTimeoutMs = options.authenticationTimeoutMs ?? 5_000;
  let capabilities: CapabilityMap = await executor.getCapabilities();
  const legacyProfiles = flattenTabs(options.config.tabs);

  const bootstrapResponse = async (): Promise<BootstrapResponse> => {
    capabilities = await executor.getCapabilities();
    const actionAvailability = await buildActionAvailability(options.config, capabilities, executor);
    return {
      version,
      applications: options.config.applications,
      tabs: options.config.tabs,
      profiles: legacyProfiles,
      capabilities,
      actionCapabilities: Object.fromEntries(
        Object.entries(actionAvailability).map(([actionId, availability]) => [actionId, availability.available]),
      ),
      actionAvailability,
      status: await status.snapshot(true, true, true),
    };
  };

  await deviceStore.init();
  await app.register(fastifyWebsocket);

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    return payload;
  });

  app.get("/api/health", async () => ({
    ok: true,
    version,
    pairingExpiresAt: pairing.current().expiresAt.toISOString(),
  }));

  app.post("/api/pair", async (request, reply) => {
    const parsed = pairRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_pair_request",
        message: parsed.error.issues.map((issue) => issue.message).join("; "),
      });
    }
    const { code, deviceName } = parsed.data;
    const deviceId = parsed.data.deviceId ?? randomUUID();
    const verified = pairing.verify(code, request.ip);
    if (!verified.ok) {
      const statusCode = verified.reason === "rate_limited" ? 429 : 401;
      return reply.code(statusCode).send({ error: verified.reason, message: pairingFailureMessage(verified.reason) });
    }

    const issued = await deviceStore.issue(deviceId, deviceName);
    const replacement = pairing.rotate();
    options.onPairingCodeRotated?.(replacement);
    return reply.code(201).send({ token: issued.token, deviceId: issued.device.id });
  });

  const requireBearer = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = bearerToken(request.headers.authorization);
    if (!token || !(await deviceStore.authenticate(token))) {
      await reply.code(401).send({ error: "unauthorized", message: "设备认证已失效，请重新配对" });
    }
  };

  app.get("/api/bootstrap", { preHandler: requireBearer }, async (_request, reply) => {
    if (reply.sent) return;
    return bootstrapResponse();
  });

  app.get("/api/status", { preHandler: requireBearer }, async (_request, reply) => {
    if (reply.sent) return;
    return status.snapshot(true, true, true);
  });

  app.post("/api/actions/:actionId/execute", { preHandler: requireBearer }, async (request, reply) => {
    if (reply.sent) return;
    const { actionId } = request.params as { actionId: string };
    const action = options.config.actions[actionId];
    const body = isRecord(request.body) ? request.body : {};
    const requestId = typeof body.requestId === "string" && body.requestId.length <= 100 ? body.requestId : randomUUID();
    if (!action) {
      const result = actionResult(requestId, actionId, false, "failed", "not_found", "未找到此操作");
      await publishActionResult(result);
      return reply.code(404).send(result);
    }

    const value = body.value;
    const inputResult = validateActionValue(actionId, action, value, options.config);
    if (inputResult) {
      const result = actionResult(requestId, actionId, false, "failed", "invalid_value", inputResult);
      await publishActionResult(result);
      return reply.code(400).send(result);
    }

    capabilities = await executor.getCapabilities();
    const availability = await actionAvailabilityFor(action, capabilities, executor);
    if (!availability.available) {
      const code = availabilityToResultCode(availability);
      const result = actionResult(requestId, actionId, false, "failed", code, availability.message ?? "当前操作不可用");
      await publishActionResult(result);
      return reply.code(responseCode(code)).send(result);
    }

    actionCount += 1;
    const execution = await executor.execute(action, value as number | undefined);
    if (!execution.ok && execution.diagnostic) {
      console.error(`Action "${actionId}" failed: ${execution.diagnostic}`);
    }
    const result = actionResult(requestId, actionId, execution.ok, execution.outcome, execution.code, execution.message);
    await publishActionResult(result, action.type === "volume");
    return reply.code(execution.ok ? 200 : responseCode(execution.code)).send(result);
  });

  if (options.adminToken) {
    const requireAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const supplied = request.headers["x-touchbar-admin"];
      if (typeof supplied !== "string" || !secureTextEquals(supplied, options.adminToken!)) {
        await reply.code(401).send({ error: "unauthorized", message: "需要有效的本机管理令牌" });
      }
    };

    app.get("/api/admin/devices", { preHandler: requireAdmin }, async (_request, reply) => {
      if (reply.sent) return;
      return (await deviceStore.list()).map(({ tokenHash: _tokenHash, ...device }) => device);
    });

    app.delete("/api/admin/devices/:deviceId", { preHandler: requireAdmin }, async (request, reply) => {
      if (reply.sent) return;
      const { deviceId } = request.params as { deviceId: string };
      if (!DEVICE_ID.test(deviceId)) {
        return reply.code(400).send({ error: "invalid_device", message: "设备 ID 无效" });
      }
      const revoked = await deviceStore.revoke(deviceId);
      if (!revoked) {
        return reply.code(404).send({ error: "not_found", message: "未找到该设备" });
      }
      for (const [client, authenticatedDeviceId] of clients) {
        if (authenticatedDeviceId === deviceId) client.close(1008, "Device revoked");
      }
      return reply.code(204).send();
    });
  }

  app.get("/ws", { websocket: true }, (socket) => {
    let authenticated = false;
    let authenticating = false;
    const timeout = setTimeout(() => {
      if (!authenticated) socket.close(1008, "认证超时");
    }, authenticationTimeoutMs);

    socket.on("message", async (raw: RawData) => {
      const message = parseClientMessage(rawDataToString(raw));
      if (!message) {
        socket.close(1008, "消息格式错误");
        return;
      }
      if (!authenticated) {
        if (message.type !== "auth" || authenticating) {
          socket.close(1008, "请先完成认证");
          return;
        }
        authenticating = true;
        const device = await deviceStore.authenticate(message.token, message.deviceId);
        if (!device) {
          send(socket, { type: "authResult", ok: false, message: "设备令牌无效" });
          socket.close(1008, "设备令牌无效");
          return;
        }
        authenticated = true;
        clearTimeout(timeout);
        clients.set(socket, device.id);
        send(socket, { type: "authResult", ok: true });
        capabilities = await executor.getCapabilities();
        send(socket, {
          type: "snapshot",
          payload: {
            ...await bootstrapResponse(),
          },
        });
        return;
      }
      if (message.type === "ping") send(socket, { type: "pong" });
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      clients.delete(socket);
    });
    socket.on("error", () => {
      clearTimeout(timeout);
      clients.delete(socket);
    });
  });

  const webRoot = options.webRoot === undefined ? resolveDefaultWebRoot() : options.webRoot;
  if (webRoot && existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false, index: ["index.html"] });
    app.get("/*", async (_request, reply) => reply.sendFile("index.html"));
  }

  const monitorIntervalMs = options.monitorIntervalMs === undefined ? 3_000 : options.monitorIntervalMs;
  let monitorBusy = false;
  const monitorTimer = monitorIntervalMs === false ? null : setInterval(() => {
    if (monitorBusy || clients.size === 0) return;
    monitorBusy = true;
    void status.snapshot(false, true, true)
      .then((currentStatus) => broadcast({ type: "status", payload: currentStatus }))
      .catch((error: unknown) => {
        console.error("系统状态刷新失败：", error instanceof Error ? error.message : error);
      })
      .finally(() => { monitorBusy = false; });
  }, monitorIntervalMs);
  monitorTimer?.unref();

  app.addHook("onClose", async () => {
    if (monitorTimer) clearInterval(monitorTimer);
    await status.close();
  });

  async function publishActionResult(result: ActionResult, refreshAudio = false): Promise<void> {
    status.recordAction(result);
    const currentStatus = await status.snapshot(refreshAudio, true, clients.size > 0);
    broadcast({ type: "actionResult", payload: result });
    broadcast({ type: "status", payload: currentStatus });
  }

  function broadcast(payload: object): void {
    for (const client of clients.keys()) {
      if (client.readyState === client.OPEN) send(client, payload);
    }
  }

  return {
    app,
    pairing,
    deviceStore,
    executor,
    close: async () => {
      if (monitorTimer) clearInterval(monitorTimer);
      await app.close();
    },
  };
}

async function buildActionAvailability(
  config: TouchBarConfig,
  capabilities: CapabilityMap,
  executor: AgentExecutor,
): Promise<Record<string, ActionAvailability>> {
  const entries = await Promise.all(Object.entries(config.actions).map(async ([actionId, action]) => [
    actionId,
    await actionAvailabilityFor(action, capabilities, executor),
  ] as const));
  return Object.fromEntries(entries);
}

async function actionAvailabilityFor(
  action: TouchBarAction,
  capabilities: CapabilityMap,
  executor: AgentExecutor,
): Promise<ActionAvailability> {
  if (!capabilities[capabilityFor(action)]) {
    return {
      available: false,
      code: action.type === "appShortcut" ? "misconfigured" : "unsupported",
      message: action.type === "appShortcut" ? "macOS 原生快捷键助手尚未构建" : unsupportedMessage(action),
    };
  }
  return executor.getActionAvailability?.(action) ?? { available: true, code: "available" };
}

function flattenTabs(tabs: DashboardTab[]): Profile[] {
  return tabs.map((tab) => ({
    id: tab.id,
    title: tab.title,
    icon: tab.icon,
    columns: Math.max(2, Math.min(12, Math.max(2, ...tab.groups.map((group) => group.columns)))),
    items: tab.groups.flatMap((group) => group.items.filter((item) => item.type !== "tokenUsage")),
  })).filter((profile) => profile.items.length > 0);
}

function secureTextEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const matched = /^Bearer\s+(.+)$/i.exec(header);
  return matched?.[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pairingFailureMessage(reason: "invalid" | "expired" | "rate_limited"): string {
  if (reason === "rate_limited") return "配对尝试次数过多，请稍后重试。";
  if (reason === "expired") return "配对码已过期。";
  return "配对码不正确。";
}

function actionResult(
  requestId: string,
  actionId: string,
  ok: boolean,
  outcome: ActionOutcome,
  code: ActionResult["code"],
  message: string,
): ActionResult {
  return { requestId, actionId, ok, outcome, code, message, timestamp: new Date().toISOString() };
}

function validateActionValue(actionId: string, action: TouchBarAction, value: unknown, config: TouchBarConfig): string | undefined {
  if (action.type !== "volume" || action.command !== "set") {
    return value === undefined ? undefined : "此操作不接受数值参数";
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return "音量必须是有效数值";
  const sliders = config.tabs.flatMap((tab) => tab.groups.flatMap((group) => group.items.filter(
    (item): item is Extract<typeof item, { type: "slider" }> => item.type === "slider" && item.actionId === actionId,
  )));
  if (sliders.length === 0) return "音量操作必须关联已配置的滑块";
  const permitted = sliders.some((slider) => {
    const steps = (value - slider.min) / slider.step;
    return value >= slider.min && value <= slider.max && Math.abs(steps - Math.round(steps)) < 1e-9;
  });
  return permitted ? undefined : "音量超出滑块允许范围";
}

function capabilityFor(action: TouchBarAction): keyof CapabilityMap {
  return action.type === "bttTrigger" ? "bttTrigger" : action.type;
}

function unsupportedMessage(action: TouchBarAction): string {
  return action.type === "bttTrigger" ? "未检测到 BetterTouchTool" : "当前 Mac 不支持此操作";
}

function availabilityToResultCode(availability: ActionAvailability): ActionResult["code"] {
  if (availability.code === "permission_required" || availability.code === "app_missing" || availability.code === "unsupported" || availability.code === "misconfigured") {
    return availability.code;
  }
  return "execution_failed";
}

function responseCode(code: ActionResult["code"]): number {
  switch (code) {
    case "invalid_value": return 400;
    case "unsupported": return 409;
    case "permission_required": return 403;
    case "app_missing": return 409;
    case "misconfigured": return 409;
    case "activation_failed": return 500;
    case "execution_failed": return 500;
    default: return 500;
  }
}

function rawDataToString(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return raw.toString("utf8");
}

function parseClientMessage(raw: string): { type: "auth"; token: string; deviceId: string } | { type: "ping" } | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || typeof value.type !== "string") return undefined;
    if (value.type === "ping") return { type: "ping" };
    if (value.type === "auth" && typeof value.token === "string" && typeof value.deviceId === "string" && DEVICE_ID.test(value.deviceId)) {
      return { type: "auth", token: value.token, deviceId: value.deviceId };
    }
  } catch {
    // Invalid JSON is rejected by the caller.
  }
  return undefined;
}

function send(socket: WebSocket, payload: object): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}
