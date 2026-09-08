import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ActionAvailability, AiDailyUsage, DashboardTab, TouchBarStatus } from "@touchbar/protocol";
import { ControlSurface, tokenUsagePropsEqual } from "./ControlSurface";

const tab: DashboardTab = {
  id: "control", role: "control", title: "控制",
  groups: [{
    id: "media", title: "QQ 音乐", kind: "section", columns: 4,
    items: [
      { id: "play", type: "button", label: "播放", actionId: "play-pause" },
      { id: "volume", type: "slider", label: "音量", actionId: "set-volume", statusKey: "volume", min: 0, max: 100, step: 1 },
      { id: "connection", type: "status", statusKey: "connection" },
    ],
  }],
};

const status: TouchBarStatus = { connected: true, volume: 35, muted: false, lastAction: null, system: null, timestamp: "2026-09-07T10:00:00.000Z" };
const available: Record<string, ActionAvailability> = {
  "play-pause": { available: true, code: "available" },
  "set-volume": { available: true, code: "available" },
};

function usage(overrides: Partial<AiDailyUsage> = {}): AiDailyUsage {
  return {
    revision: "ai-1", date: "2026-09-07", timezone: "Asia/Shanghai", currency: "USD", collector: "ccusage", collectorVersion: "1.8.0", status: "ready",
    lastSuccessfulRefreshAt: "2026-09-07T10:00:00.000Z", nextRefreshAt: "2026-09-07T10:10:00.000Z", error: null,
    totals: { inputTokens: 120_000, outputTokens: 6_000, cacheReadTokens: 90_000, cacheCreationTokens: 1_000, totalTokens: 126_000, costUsd: 1.2345, costStatus: "estimated" },
    models: [{ model: "gpt-5.6-sol", sources: ["codex"], inputTokens: 120_000, outputTokens: 6_000, cacheReadTokens: 90_000, cacheCreationTokens: 1_000, totalTokens: 126_000, costUsd: 1.2345, costStatus: "estimated" }],
    sources: ["codex"],
    ...overrides,
  };
}

function monitorStatus(aiDailyUsage: AiDailyUsage | null | undefined): TouchBarStatus {
  return {
    ...status,
    system: {
      hostname: "studio-mac", macosVersion: "26.2", lanAddress: "192.168.1.8", cpuPercent: 12.5, loadAverage1m: 1.2,
      memoryUsedBytes: 8_000_000_000, memoryTotalBytes: 16_000_000_000, memoryPercent: 50,
      diskUsedBytes: 100_000_000_000, diskTotalBytes: 200_000_000_000, diskPercent: 50, batteryPercent: 80, batteryCharging: true,
      systemUptimeSeconds: 3600, agentUptimeSeconds: 60, connectedClients: 1, actionCount: 3, codexDailyUsage: null,
      ...(aiDailyUsage === undefined ? {} : { aiDailyUsage }), timestamp: status.timestamp,
    },
  };
}

function surface(props: Partial<Parameters<typeof ControlSurface>[0]> = {}) {
  return <ControlSurface tab={tab} applications={{}} status={status} online actionAvailability={available} pendingActionIds={new Set()} onAction={vi.fn()} {...props} />;
}

const aiMonitor: DashboardTab = {
  id: "monitor", role: "monitor", title: "系统监控", groups: [
    { id: "resources", title: "系统资源", kind: "metrics", columns: 4, items: [{ id: "cpu", type: "status", label: "CPU", statusKey: "cpu" }] },
    { id: "machine", title: "设备与 Agent", kind: "metrics", presentation: "details", columns: 2, items: [{ id: "network", type: "status", label: "网络", statusKey: "network" }] },
    { id: "ai", title: "今日 AI 用量", kind: "metrics", columns: 1, items: [{ id: "usage", type: "tokenUsage", label: "AI 用量" }] },
  ],
};

describe("ControlSurface", () => {
  it("invokes configured buttons and throttled slider actions", () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(surface({ onAction }));
    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    fireEvent.change(screen.getByLabelText("音量"), { target: { value: "48" } });
    expect(onAction).toHaveBeenNthCalledWith(1, "play-pause");
    expect(onAction).toHaveBeenNthCalledWith(2, "set-volume", 48);
    expect(screen.getByText("Mac 已连接")).toBeInTheDocument();
  });

  it("keeps controls unavailable while offline or permission is missing", () => {
    render(surface({ online: false, actionAvailability: { ...available, "play-pause": { available: false, code: "permission_required", message: "请授予辅助功能权限" } } }));
    expect(screen.getByRole("button", { name: "播放" })).toBeDisabled();
    expect(screen.getByLabelText("音量")).toBeDisabled();
    expect(screen.getByText("正在重连")).toBeInTheDocument();
    expect(screen.getByText("请授予辅助功能权限")).toBeInTheDocument();
  });

  it("uses configured group span and item count, including a single favorite app", () => {
    const single: DashboardTab = { id: "shortcuts", role: "shortcuts", title: "快捷方式", groups: [{ id: "favorite", title: "常用", kind: "app", columns: 4, span: "full", items: [{ id: "one", type: "button", label: "打开网站", actionId: "play-pause" }] }] };
    const { container } = render(surface({ tab: single }));
    expect(container.querySelector(".dashboard-group")).toHaveClass("full-span");
    expect(container.querySelector(".touch-grid")?.getAttribute("style")).toContain("--items: 1");
  });

  it("keeps the AI group full width for loading and compatibility empty states, and uses compact detail rows", () => {
    const { container, rerender } = render(surface({ tab: aiMonitor, status: monitorStatus(null) }));
    const aiCard = screen.getByRole("region", { name: "今日 AI 用量" }).closest(".dashboard-group");
    expect(aiCard).toHaveClass("full-span");
    expect(screen.getByText("正在等待 AI 用量采集器初始化…")).toBeInTheDocument();
    expect(container.querySelector(".compact-status")).toBeInTheDocument();

    rerender(surface({ tab: aiMonitor, status: monitorStatus(undefined) }));
    expect(screen.getByText("当前 Mac 尚未提供 AI 用量数据（兼容模式）。")).toBeInTheDocument();
  });

  it("renders ccusage costs, partial status, all model fields, and unknown prices without treating them as free", () => {
    const partial = usage({
      status: "stale", error: "ccusage 暂不可用",
      totals: { inputTokens: 9, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, totalTokens: 18, costUsd: 0.12, costStatus: "partial" },
      models: [
        { model: "known", sources: ["codex", "claude"], inputTokens: 9, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, totalTokens: 18, costUsd: 0.12, costStatus: "partial" },
        { model: "unknown", sources: ["claude"], inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 2, costUsd: null, costStatus: "unknown" },
      ],
    });
    render(surface({ tab: aiMonitor, status: monitorStatus(partial) }));
    expect(screen.getByText("估算费用（部分）")).toBeInTheDocument();
    expect(screen.getByText("显示上次成功采集的数据。 ccusage 暂不可用")).toBeInTheDocument();
    expect(screen.getAllByText("价格待确认").length).toBeGreaterThan(0);
    expect(screen.getByText("USD 估算费用，非实际扣费账单")).toBeInTheDocument();
    const row = within(screen.getAllByText("known")[0]!.closest("tr")!).getByText("codex、claude");
    expect(row).toBeInTheDocument();
    expect(screen.getAllByText("缓存创建").length).toBeGreaterThan(0);
  });

  it("does not turn collector errors into a zero-use day, while retaining a valid zero total", () => {
    const { rerender } = render(surface({ tab: aiMonitor, status: monitorStatus(usage({ totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUsd: null, costStatus: "unknown" }, models: [] })) }));
    expect(screen.getByText("今天尚无 AI 使用记录。")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    rerender(surface({ tab: aiMonitor, status: monitorStatus(usage({ revision: "error-1", status: "error", totals: null, models: [], error: "collector exited" })) }));
    expect(screen.getByText("暂时无法读取 AI 用量。")).toBeInTheDocument();
    expect(screen.queryByText("今天尚无 AI 使用记录。")).not.toBeInTheDocument();
  });

  it("memoizes the token panel by collector revision, not system refresh object identity", () => {
    const first = usage({ revision: "same" });
    expect(tokenUsagePropsEqual({ usage: first }, { usage: { ...first } })).toBe(true);
    expect(tokenUsagePropsEqual({ usage: first }, { usage: usage({ revision: "next" }) })).toBe(false);
  });
});
