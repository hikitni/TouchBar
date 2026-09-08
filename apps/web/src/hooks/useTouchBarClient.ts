import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActionResult,
  BootstrapResponse,
  CapabilityMap,
  DashboardTab,
  ServerMessage,
  TouchBarStatus
} from "@touchbar/protocol";
import { ApiError, fetchBootstrap, invokeAction, pairDevice, webSocketUrl } from "../lib/api";
import {
  clearCredentials,
  loadCredentials,
  saveCredentials,
  type DeviceCredentials
} from "../lib/storage";

export type ClientPhase = "pairing" | "loading" | "ready" | "error";

export interface TouchBarClient {
  phase: ClientPhase;
  bootstrap: BootstrapResponse | null;
  online: boolean;
  error: string | null;
  pendingActionIds: ReadonlySet<string>;
  /** Only action results received during this client lifetime; bootstrap history is excluded. */
  actionResult: ActionResult | null;
  pair: (code: string, deviceName: string) => Promise<void>;
  retry: () => void;
  forgetDevice: () => void;
  invoke: (actionId: string, value?: number) => Promise<ActionResult | null>;
}

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function statusFromMessage(message: ServerMessage): TouchBarStatus | null {
  if (message.type === "status") return message.payload;
  if (message.type === "snapshot") return message.payload.status;
  return null;
}

function preserveAiUsage(previous: TouchBarStatus | undefined, next: TouchBarStatus): TouchBarStatus {
  const previousUsage = previous?.system?.aiDailyUsage;
  const nextUsage = next.system?.aiDailyUsage;
  if (!previousUsage || !nextUsage || previousUsage.revision !== nextUsage.revision || next.system === null) return next;
  return { ...next, system: { ...next.system, aiDailyUsage: previousUsage } };
}

function updateBootstrap(
  current: BootstrapResponse | null,
  message: ServerMessage
): BootstrapResponse | null {
  if (message.type === "snapshot") {
    if (!current) return message.payload;
    return { ...message.payload, status: preserveAiUsage(current.status, message.payload.status) };
  }
  if (!current) return current;

  const status = statusFromMessage(message);
  if (status) return { ...current, status: preserveAiUsage(current.status, status) };
  if (message.type === "capabilitiesChanged") return { ...current, capabilities: message.payload };
  if (message.type === "configChanged") return { ...current, ...message.payload };
  if (message.type === "actionResult") return { ...current, status: { ...current.status, lastAction: message.payload } };
  return current;
}

function dashboardActionIds(tabs: DashboardTab[] | undefined): Set<string> {
  return new Set(
    tabs?.flatMap((tab) => tab.groups.flatMap((group) =>
      group.items.flatMap((item) => ("actionId" in item ? [item.actionId] : [])),
    )) ?? [],
  );
}

export function useTouchBarClient(): TouchBarClient {
  const [credentials, setCredentials] = useState<DeviceCredentials | null>(() => loadCredentials());
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [phase, setPhase] = useState<ClientPhase>(() => (loadCredentials() ? "loading" : "pairing"));
  const [online, setOnline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingActionIds, setPendingActionIds] = useState<ReadonlySet<string>>(() => new Set());
  const [actionResult, setActionResult] = useState<ActionResult | null>(null);
  const reloadNonce = useRef(0);
  const [reloadVersion, setReloadVersion] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const reconnectAttempt = useRef(0);
  const allowedActionIds = useMemo(() => dashboardActionIds(bootstrap?.tabs), [bootstrap?.tabs]);

  const retry = useCallback(() => {
    reloadNonce.current += 1;
    setReloadVersion(reloadNonce.current);
  }, []);

  const forgetDevice = useCallback(() => {
    clearCredentials();
    setCredentials(null);
    setBootstrap(null);
    setOnline(false);
    setError(null);
    setPhase("pairing");
  }, []);

  const pair = useCallback(async (code: string, deviceName: string) => {
    setError(null);
    setPhase("loading");
    try {
      const paired = await pairDevice(code, deviceName);
      if (!paired.deviceId || !paired.token) throw new Error("Mac 返回的配对信息不完整。");
      const nextCredentials = { deviceId: paired.deviceId, token: paired.token };
      saveCredentials(nextCredentials);
      setCredentials(nextCredentials);
    } catch (pairingError) {
      setPhase("pairing");
      setError(errorMessage(pairingError, "配对失败，请检查配对码后重试。"));
      throw pairingError;
    }
  }, []);

  useEffect(() => {
    if (!credentials) return;

    let cancelled = false;
    setPhase("loading");
    setError(null);
    setActionResult(null);
    setOnline(false);

    void fetchBootstrap(credentials)
      .then((response) => {
        if (cancelled) return;
        setBootstrap(response);
        setPhase("ready");
      })
      .catch((bootstrapError: unknown) => {
        if (cancelled) return;
        if (bootstrapError instanceof ApiError && bootstrapError.status === 401) {
          clearCredentials();
          setCredentials(null);
          setBootstrap(null);
          setPhase("pairing");
          setError("此设备的配对已失效，请输入新的配对码。");
          return;
        }
        setPhase("error");
        setError(errorMessage(bootstrapError, "无法加载 Touch Bar。"));
      });

    return () => {
      cancelled = true;
    };
  }, [credentials, reloadVersion]);

  useEffect(() => {
    if (!credentials || phase !== "ready") return;

    let disposed = false;
    let authenticated = false;
    let retryAllowed = true;

    const clearTimer = () => {
      if (reconnectTimer.current !== null) {
        window.clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer.current !== null) return;
      const delay = Math.min(RECONNECT_MIN_MS * 2 ** reconnectAttempt.current, RECONNECT_MAX_MS);
      reconnectAttempt.current += 1;
      reconnectTimer.current = window.setTimeout(() => {
        reconnectTimer.current = null;
        connect();
      }, delay);
    };

    let connect: () => void;
    connect = () => {
      if (disposed) return;
      setOnline(false);
      const socket = new WebSocket(webSocketUrl());
      socketRef.current = socket;

      socket.onopen = () => {
        // Authentication is intentionally the first application message sent over this connection.
        socket.send(JSON.stringify({ type: "auth", token: credentials.token, deviceId: credentials.deviceId }));
      };
      socket.onmessage = (event: MessageEvent<string>) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }
        if (message.type === "authResult") {
          authenticated = message.ok;
          if (!message.ok) {
            retryAllowed = false;
            setOnline(false);
            setError(message.message ?? "实时连接认证失败。");
            socket.close();
            return;
          }
          reconnectAttempt.current = 0;
          setOnline(true);
          return;
        }
        if (message.type === "actionResult") setActionResult(message.payload);
        setBootstrap((current) => updateBootstrap(current, message));
      };
      socket.onerror = () => {
        // onclose owns retry scheduling so errors and normal disconnects are handled uniformly.
      };
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        setOnline(false);
        if (retryAllowed && !disposed) scheduleReconnect();
      };
    };

    connect();
    return () => {
      disposed = true;
      clearTimer();
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
    };
  }, [credentials, phase]);

  const invoke = useCallback(async (actionId: string, value?: number): Promise<ActionResult | null> => {
    if (!credentials || !online) return null;
    if (!allowedActionIds.has(actionId)) {
      setError("当前 Touch Bar 配置中没有此操作。");
      return null;
    }

    setError(null);
    setPendingActionIds((current) => new Set(current).add(actionId));
    try {
      const result = await invokeAction(credentials, actionId, value);
      setActionResult(result);
      setBootstrap((current) => current
        ? { ...current, status: { ...current.status, lastAction: result } }
        : current);
      return result;
    } catch (actionError) {
      const message = errorMessage(actionError, "操作执行失败。");
      const result: ActionResult = {
        requestId: "local-error",
        actionId,
        ok: false,
        outcome: "failed",
        code: "execution_failed",
        message,
        timestamp: new Date().toISOString()
      };
      setError(message);
      setActionResult(result);
      setBootstrap((current) => current
        ? { ...current, status: { ...current.status, lastAction: result } }
        : current);
      return result;
    } finally {
      setPendingActionIds((current) => {
        const next = new Set(current);
        next.delete(actionId);
        return next;
      });
    }
  }, [allowedActionIds, credentials, online]);

  return { phase, bootstrap, online, error, pendingActionIds, actionResult, pair, retry, forgetDevice, invoke };
}
