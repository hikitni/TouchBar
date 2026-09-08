import type { AiDailyUsage, MacSystemStatus } from "@touchbar/protocol";
import type { AiUsageCollector } from "../../src/ai-usage.js";
import { SystemMonitor, type AgentRuntimeStatus } from "../../src/system-monitor.js";

export function sampleAiUsage(overrides: Partial<AiDailyUsage> = {}): AiDailyUsage {
  return {
    revision: "test:1", date: "2026-09-08", timezone: "Asia/Shanghai", currency: "USD",
    collector: "ccusage", collectorVersion: "20.0.20", status: "loading",
    lastSuccessfulRefreshAt: null, nextRefreshAt: null, error: null,
    totals: null, models: [], sources: [], ...overrides,
  };
}

/** Hermetic API fixtures must never scan the developer's real usage logs. */
export class StubAiUsageCollector implements AiUsageCollector {
  public value = sampleAiUsage();
  public refreshRequests = 0;
  public closed = false;
  public snapshot(refresh = false): AiDailyUsage {
    if (refresh) this.refreshRequests += 1;
    return this.value;
  }
  public async close(): Promise<void> { this.closed = true; }
}

export class TestSystemMonitor extends SystemMonitor {
  public snapshots = 0;
  public constructor(public readonly collector = new StubAiUsageCollector()) {
    super({ aiUsageCollector: collector });
  }
  public override async snapshot(runtime: AgentRuntimeStatus): Promise<MacSystemStatus> {
    this.snapshots += 1;
    return {
      hostname: "test-mac", macosVersion: "test", lanAddress: "127.0.0.1", cpuPercent: 10,
      loadAverage1m: 1, memoryUsedBytes: 100, memoryTotalBytes: 1000, memoryPercent: 10,
      diskUsedBytes: 100, diskTotalBytes: 1000, diskPercent: 10, batteryPercent: null,
      batteryCharging: null, systemUptimeSeconds: 60, ...runtime, codexDailyUsage: null,
      aiDailyUsage: this.getAiUsage(), timestamp: new Date().toISOString(),
    };
  }
}
