import { describe, expect, it } from "vitest";
import { memoryUsage, parseBatteryStatus, SystemMonitor } from "../src/system-monitor.js";
import { StubAiUsageCollector, sampleAiUsage } from "./support/ai-usage.js";

const runtime = { agentUptimeSeconds: 12, connectedClients: 2, actionCount: 7 };

describe("SystemMonitor", () => {
  it("uses macOS memory pressure instead of raw free-page memory", () => {
    expect(memoryUsage("System-wide memory free percentage: 44%", 1000)).toEqual({ memoryUsedBytes: 560, memoryPercent: 56 });
  });

  it("parses charging and discharging battery output", () => {
    expect(parseBatteryStatus("-InternalBattery-0\t87%; charging; 0:25 remaining")).toEqual({ batteryPercent: 87, batteryCharging: true });
    expect(parseBatteryStatus("-InternalBattery-0\t41%; discharging; 3:10 remaining")).toEqual({ batteryPercent: 41, batteryCharging: false });
  });

  it("keeps AI collection outside system sampling and retires the Codex-only poller", async () => {
    const collector = new StubAiUsageCollector();
    const now = new Date("2026-09-08T02:00:00+08:00");
    const monitor = new SystemMonitor({ aiUsageCollector: collector, now: () => now, slowRefreshMs: 0 });
    const status = await monitor.snapshot(runtime);
    expect(status).toMatchObject({ ...runtime, codexDailyUsage: null, codexTokens: null, aiDailyUsage: { status: "loading", totals: null }, timestamp: now.toISOString() });
    expect(status.memoryTotalBytes).toBeGreaterThan(0);
    expect(collector.refreshRequests).toBe(0);
    expect(monitor.getAiUsage(true)).toBe(collector.value);
    expect(collector.refreshRequests).toBe(1);
    await monitor.close();
    expect(collector.closed).toBe(true);
  });

  it("exposes new AI snapshots without waiting for the 15-second slow metrics cache", async () => {
    const collector = new StubAiUsageCollector();
    const monitor = new SystemMonitor({ aiUsageCollector: collector, slowRefreshMs: 15000 });
    const before = await monitor.snapshot(runtime);
    collector.value = sampleAiUsage({ revision: "test:2", status: "error", error: "采集失败" });
    const after = await monitor.snapshot(runtime);
    expect(before.aiDailyUsage?.status).toBe("loading");
    expect(after.aiDailyUsage).toMatchObject({ revision: "test:2", status: "error", error: "采集失败" });
    expect(collector.refreshRequests).toBe(0);
    await monitor.close();
  });
});
