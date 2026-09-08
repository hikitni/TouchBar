import type { ActionResult, BootstrapResponse } from "@touchbar/protocol";
import type { DeviceCredentials } from "./storage";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string"
      ? (body as { message: string }).message
      : `Request failed (${response.status})`;
    throw new ApiError(response.status, message);
  }
  return body as T;
}

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

export interface PairingResponse extends DeviceCredentials {
  deviceName?: string;
}

export async function pairDevice(code: string, deviceName: string): Promise<PairingResponse> {
  const response = await fetch("/api/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, deviceName })
  });
  return readJson<PairingResponse>(response);
}

export async function fetchBootstrap(credentials: DeviceCredentials): Promise<BootstrapResponse> {
  const response = await fetch("/api/bootstrap", { headers: authHeaders(credentials.token) });
  return readJson<BootstrapResponse>(response);
}

export async function invokeAction(
  credentials: DeviceCredentials,
  actionId: string,
  value?: number
): Promise<ActionResult> {
  const response = await fetch(`/api/actions/${encodeURIComponent(actionId)}/execute`, {
    method: "POST",
    headers: { ...authHeaders(credentials.token), "Content-Type": "application/json" },
    body: JSON.stringify(value === undefined ? {} : { value })
  });
  const body: unknown = await response.json().catch(() => null);
  if (isActionResult(body)) return body;
  const message = body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string"
    ? (body as { message: string }).message
    : `操作请求失败（${response.status}）`;
  throw new ApiError(response.status, message);
}

function isActionResult(value: unknown): value is ActionResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ActionResult>;
  return typeof candidate.actionId === "string"
    && typeof candidate.requestId === "string"
    && typeof candidate.ok === "boolean"
    && typeof candidate.outcome === "string"
    && typeof candidate.code === "string"
    && typeof candidate.message === "string"
    && typeof candidate.timestamp === "string";
}

export function webSocketUrl(): string {
  const url = new URL("/ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
