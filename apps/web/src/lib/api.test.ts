import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeAction, pairDevice } from "./api";

const credentials = { deviceId: "device-1", token: "secret-token" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Touch Bar API client", () => {
  it("uses the server pairing contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(credentials), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await pairDevice("123456", "Tablet");

    expect(fetchMock).toHaveBeenCalledWith("/api/pair", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ code: "123456", deviceName: "Tablet" }),
    }));
  });

  it("invokes only the canonical execute endpoint with bearer auth", async () => {
    const result = {
      requestId: "request-1",
      actionId: "volume.set",
      ok: true,
      outcome: "verified",
      code: "ok",
      message: "done",
      timestamp: new Date().toISOString(),
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await invokeAction(credentials, "volume.set", 42);

    expect(fetchMock).toHaveBeenCalledWith("/api/actions/volume.set/execute", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer secret-token" }),
      body: JSON.stringify({ value: 42 }),
    }));
  });

  it("returns a structured failed action result from a non-2xx response", async () => {
    const result = {
      requestId: "request-2",
      actionId: "brightness_up",
      ok: false,
      outcome: "failed",
      code: "permission_required",
      message: "需要授予 macOS 权限才能执行此操作",
      timestamp: new Date().toISOString(),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(result), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(invokeAction(credentials, "brightness_up")).resolves.toEqual(result);
  });
});
