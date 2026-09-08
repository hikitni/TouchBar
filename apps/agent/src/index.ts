import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-terminal";
import { loadOrCreateAdminToken, readAdminToken } from "./admin.js";
import { createAgentApp } from "./app.js";
import { loadConfig } from "./config.js";

export async function startAgent(): Promise<void> {
  const configPath = process.env.TOUCHBAR_CONFIG;
  const config = await loadConfig(configPath);
  const adminToken = await loadOrCreateAdminToken();
  const agent = await createAgentApp({
    config,
    adminToken,
    onPairingCodeRotated: ({ code, expiresAt }) => {
      console.log(`New one-time pairing code: ${code} (expires ${expiresAt.toLocaleTimeString()})`);
    },
  });

  const address = await agent.app.listen({ port: config.server.port, host: "0.0.0.0" });
  const port = new URL(address).port || String(config.server.port);
  const urls = [`http://localhost:${port}`, ...lanUrls(port)];
  const pairing = agent.pairing.current();

  console.log("HTTP Touch Bar Agent is running.");
  console.log(`Pairing code: ${pairing.code} (expires ${pairing.expiresAt.toLocaleTimeString()})`);
  console.log("Open one of these trusted-LAN URLs:");
  for (const url of urls) console.log(`  ${url}`);
  console.log("QR code:");
  qrcode.generate(urls[1] ?? urls[0]!, { small: true });

  const shutdown = async () => {
    await agent.close();
    process.exit(0);
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}

export async function manageDevices(args: string[]): Promise<void> {
  const command = args[0];
  if (command !== "list" && command !== "revoke") {
    throw new Error("Usage: pnpm devices list | pnpm devices revoke <device-id>");
  }
  const config = await loadConfig(process.env.TOUCHBAR_CONFIG);
  const adminToken = await readAdminToken();
  const baseUrl = `http://127.0.0.1:${config.server.port}`;
  const headers = { "X-TouchBar-Admin": adminToken };

  if (command === "list") {
    const response = await fetch(`${baseUrl}/api/admin/devices`, { headers });
    const devices = await readAdminResponse<Array<{ id: string; name: string; createdAt: string; lastSeenAt: string }>>(response);
    if (devices.length === 0) {
      console.log("No paired devices.");
      return;
    }
    console.table(devices.map(({ id, name, lastSeenAt }) => ({ id, name, lastSeenAt })));
    return;
  }

  const deviceId = args[1];
  if (!deviceId) throw new Error("Usage: pnpm devices revoke <device-id>");
  const response = await fetch(`${baseUrl}/api/admin/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE", headers });
  if (response.status !== 204) await readAdminResponse(response);
  console.log(`Revoked device: ${deviceId}`);
}

async function readAdminResponse<T = unknown>(response: Response): Promise<T> {
  if (response.ok) {
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
  const body = await response.json().catch(() => null) as { message?: unknown } | null;
  const message = body && typeof body.message === "string" ? body.message : `Admin request failed (${response.status})`;
  throw new Error(message);
}

export function lanUrls(port: string): string[] {
  const urls = new Set<string>();
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        urls.add(`http://${address.address}:${port}`);
      }
    }
  }
  return [...urls].sort();
}

async function main(args: string[]): Promise<void> {
  if (args[0] === "devices") {
    await manageDevices(args.slice(1));
    return;
  }
  if (args.length > 0) throw new Error(`Unknown command: ${args.join(" ")}`);
  await startAgent();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
