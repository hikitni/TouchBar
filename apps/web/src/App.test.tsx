import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult, BootstrapResponse } from "@touchbar/protocol";

const mocked = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("./hooks/useTouchBarClient", () => ({ useTouchBarClient: () => mocked.client }));

import App from "./App";

const bootstrap: BootstrapResponse = {
  version: "1.3.0", applications: {},
  capabilities: { media: true, volume: true, brightness: true, system: true, launchApp: true, openUrl: true, keystroke: true, appShortcut: true, bttTrigger: false },
  actionCapabilities: { play: true, sleep: true },
  actionAvailability: { play: { available: true, code: "available" }, sleep: { available: true, code: "available" } },
  status: { connected: true, volume: 50, muted: false, lastAction: null, system: null, timestamp: "2026-09-07T10:00:00.000Z" },
  tabs: [
    { id: "monitor", role: "monitor", title: "系统监控", icon: "📊", groups: [{ id: "metrics", title: "系统资源", columns: 2, kind: "metrics", items: [{ id: "cpu", type: "status", label: "CPU", statusKey: "cpu" }] }] },
    { id: "control", role: "control", title: "控制", icon: "◉", groups: [{ id: "media", title: "QQ 音乐", columns: 2, kind: "section", items: [{ id: "play", type: "button", label: "播放", actionId: "play" }] }] },
    { id: "shortcuts", role: "shortcuts", title: "快捷方式", icon: "↗", groups: [{ id: "links", title: "常驻网站", columns: 2, kind: "section", items: [{ id: "sleep", type: "button", label: "网站", actionId: "sleep" }] }] },
  ], profiles: [],
};

function readyClient(overrides: Record<string, unknown> = {}) {
  return { phase: "ready" as const, bootstrap, online: true, error: null, pendingActionIds: new Set<string>(), actionResult: null, pair: vi.fn(), retry: vi.fn(), forgetDevice: vi.fn(), invoke: vi.fn().mockResolvedValue(null), ...overrides };
}

function result(outcome: ActionResult["outcome"], message: string, requestId = "request-1"): ActionResult {
  return { requestId, actionId: "play", ok: outcome !== "failed", outcome, code: outcome === "failed" ? "execution_failed" : "ok", message, timestamp: "2026-09-07T10:00:01.000Z" };
}

function pointer(type: string, x: number, y: number): Event {
  const event = new Event(type, { bubbles: true });
  Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y } });
  return event;
}

describe("App tab and action feedback", () => {
  beforeEach(() => { window.localStorage.clear(); });
  afterEach(() => { vi.useRealTimers(); });

  it("remembers tabs, supports click and horizontal surface swipe, and ignores control gestures", () => {
    mocked.client = readyClient();
    const { unmount } = render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: "控制" }));
    expect(screen.getByRole("heading", { name: "控制" })).toBeInTheDocument();
    expect(window.localStorage.getItem("touchbar.selected-tab.v2")).toBe("control");

    const surface = screen.getAllByLabelText("控制面板")[0]!;
    fireEvent(surface, pointer("pointerdown", 220, 20));
    fireEvent(surface, pointer("pointermove", 100, 22));
    fireEvent(surface, pointer("pointerup", 100, 22));
    expect(screen.getByRole("heading", { name: "快捷方式" })).toBeInTheDocument();

    fireEvent(screen.getByRole("button", { name: "网站" }), pointer("pointerdown", 220, 20));
    fireEvent(screen.getByRole("button", { name: "网站" }), pointer("pointerup", 100, 20));
    expect(screen.getByRole("heading", { name: "快捷方式" })).toBeInTheDocument();
    unmount();

    mocked.client = readyClient();
    render(<App />);
    expect(screen.getByRole("heading", { name: "快捷方式" })).toBeInTheDocument();
  });

  it("shows only live action results, hides accepted/verified feedback after five seconds, and leaves failures dismissible", () => {
    vi.useFakeTimers();
    mocked.client = readyClient({ bootstrap: { ...bootstrap, status: { ...bootstrap.status, lastAction: result("accepted", "旧的 bootstrap 记录") } } });
    const view = render(<App />);
    expect(screen.queryByText("指令已发送")).not.toBeInTheDocument();

    mocked.client = readyClient({ actionResult: result("accepted", "已发送") });
    view.rerender(<App />);
    expect(screen.getByText("指令已发送")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(screen.queryByText("指令已发送")).not.toBeInTheDocument();

    mocked.client = readyClient({ actionResult: result("failed", "权限不足", "request-2") });
    view.rerender(<App />);
    expect(screen.getByText("操作失败")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByText("操作失败")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭操作反馈" }));
    expect(screen.queryByText("操作失败")).not.toBeInTheDocument();
  });

  it("does not let an older success timer dismiss a newer failure", () => {
    vi.useFakeTimers();
    mocked.client = readyClient({ actionResult: result("verified", "已验证", "request-1") });
    const view = render(<App />);
    act(() => { vi.advanceTimersByTime(4_000); });
    mocked.client = readyClient({ actionResult: result("failed", "新的失败", "request-2") });
    view.rerender(<App />);
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(screen.getByText("操作失败")).toBeInTheDocument();
  });
});
