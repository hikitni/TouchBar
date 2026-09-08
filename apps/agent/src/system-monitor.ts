import { spawn } from "node:child_process";
import { statfs } from "node:fs/promises";
import { hostname, loadavg, networkInterfaces, cpus, freemem, totalmem, uptime } from "node:os";
import type { AiDailyUsage, MacSystemStatus } from "@touchbar/protocol";
import { CcusageDailyUsageCollector, type AiUsageCollector } from "./ai-usage.js";

const PMSET = "/usr/bin/pmset";
const SW_VERS = "/usr/bin/sw_vers";
const MEMORY_PRESSURE = "/usr/bin/memory_pressure";
const SLOW_REFRESH_MS = 15_000;

export interface AgentRuntimeStatus {
  agentUptimeSeconds: number;
  connectedClients: number;
  actionCount: number;
}

interface CpuSample {
  idle: number;
  total: number;
}

interface SlowMetrics {
  macosVersion: string;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  diskPercent: number | null;
  batteryPercent: number | null;
  batteryCharging: boolean | null;
}

export interface SystemMonitorOptions {
  now?: () => Date;
  slowRefreshMs?: number;
  aiUsageCollector?: AiUsageCollector;
}

export class SystemMonitor {
  private readonly now: () => Date;
  private readonly slowRefreshMs: number;
  private readonly aiUsageCollector: AiUsageCollector;
  private previousCpu: CpuSample | null = null;
  private slowMetrics: SlowMetrics | null = null;
  private slowMetricsAt = 0;
  private slowRefresh: Promise<SlowMetrics> | null = null;

  public constructor(options: SystemMonitorOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.slowRefreshMs = options.slowRefreshMs ?? SLOW_REFRESH_MS;
    this.aiUsageCollector = options.aiUsageCollector ?? new CcusageDailyUsageCollector({ now: this.now });
  }

  public getAiUsage(refresh = false): AiDailyUsage {
    return this.aiUsageCollector.snapshot(refresh);
  }

  public async close(): Promise<void> {
    await this.aiUsageCollector.close();
  }

  public async snapshot(runtime: AgentRuntimeStatus): Promise<MacSystemStatus> {
    const currentCpu = cpuSample();
    const cpuPercent = cpuUsagePercent(this.previousCpu, currentCpu);
    this.previousCpu = currentCpu;

    const totalMemory = totalmem();
    const [slow, memory] = await Promise.all([
      this.getSlowMetrics(),
      runText(MEMORY_PRESSURE, ["-Q"]).then((output) => memoryUsage(output, totalMemory)),
    ]);

    return {
      hostname: hostname(),
      macosVersion: slow.macosVersion,
      lanAddress: preferredLanAddress(),
      cpuPercent,
      loadAverage1m: round(loadavg()[0] ?? 0, 2),
      memoryUsedBytes: memory.memoryUsedBytes,
      memoryTotalBytes: totalMemory,
      memoryPercent: memory.memoryPercent,
      diskUsedBytes: slow.diskUsedBytes,
      diskTotalBytes: slow.diskTotalBytes,
      diskPercent: slow.diskPercent,
      batteryPercent: slow.batteryPercent,
      batteryCharging: slow.batteryCharging,
      systemUptimeSeconds: Math.round(uptime()),
      ...runtime,
      codexDailyUsage: null,
      aiDailyUsage: this.getAiUsage(),
      codexTokens: null,
      timestamp: this.now().toISOString(),
    };
  }

  private async getSlowMetrics(): Promise<SlowMetrics> {
    const now = this.now().getTime();
    if (this.slowMetrics && now - this.slowMetricsAt < this.slowRefreshMs) return this.slowMetrics;
    if (!this.slowRefresh) {
      this.slowRefresh = this.refreshSlowMetrics().finally(() => { this.slowRefresh = null; });
    }
    this.slowMetrics = await this.slowRefresh;
    this.slowMetricsAt = this.now().getTime();
    return this.slowMetrics;
  }

  private async refreshSlowMetrics(): Promise<SlowMetrics> {
    const [macosVersion, disk, battery] = await Promise.all([
      runText(SW_VERS, ["-productVersion"]).then((value) => value?.trim() || "未知"),
      diskUsage(),
      runText(PMSET, ["-g", "batt"]).then(parseBatteryStatus),
    ]);
    return { macosVersion, ...disk, ...battery };
  }
}

export function memoryUsage(output: string | null, totalMemory = totalmem()): Pick<MacSystemStatus, "memoryUsedBytes" | "memoryPercent"> {
  const availablePercent = nullableNumber(output?.match(/memory free percentage:\s*(\d+(?:\.\d+)?)%/i)?.[1]);
  if (availablePercent !== null) {
    const memoryPercent = round(Math.max(0, Math.min(100, 100 - availablePercent)), 1);
    return { memoryUsedBytes: Math.round(totalMemory * memoryPercent / 100), memoryPercent };
  }
  const memoryUsedBytes = Math.max(0, totalMemory - freemem());
  return { memoryUsedBytes, memoryPercent: percent(memoryUsedBytes, totalMemory) };
}

export function parseBatteryStatus(output: string | null): Pick<MacSystemStatus, "batteryPercent" | "batteryCharging"> {
  if (!output) return { batteryPercent: null, batteryCharging: null };
  const batteryPercent = nullableNumber(output.match(/(\d+)%/)?.[1]);
  const batteryCharging = /\b(charging|charged|finishing charge)\b/i.test(output)
    ? true
    : /\bdischarging\b/i.test(output)
      ? false
      : null;
  return { batteryPercent, batteryCharging };
}

async function diskUsage(): Promise<Pick<SlowMetrics, "diskUsedBytes" | "diskTotalBytes" | "diskPercent">> {
  try {
    const info = await statfs("/");
    const diskTotalBytes = info.blocks * info.bsize;
    const diskFreeBytes = info.bavail * info.bsize;
    const diskUsedBytes = Math.max(0, diskTotalBytes - diskFreeBytes);
    return { diskUsedBytes, diskTotalBytes, diskPercent: percent(diskUsedBytes, diskTotalBytes) };
  } catch {
    return { diskUsedBytes: null, diskTotalBytes: null, diskPercent: null };
  }
}

function cpuSample(): CpuSample {
  return cpus().reduce<CpuSample>((summary, cpu) => {
    const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return { idle: summary.idle + cpu.times.idle, total: summary.total + total };
  }, { idle: 0, total: 0 });
}

function cpuUsagePercent(previous: CpuSample | null, current: CpuSample): number | null {
  if (!previous) return null;
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) return null;
  return round(Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)), 1);
}

function preferredLanAddress(): string | null {
  const interfaces = networkInterfaces();
  const preferred = ["en0", "en1"];
  const names = [...preferred, ...Object.keys(interfaces).filter((name) => !preferred.includes(name) && !/^lo|^utun|^awdl|^llw/.test(name))];
  for (const name of names) {
    const address = interfaces[name]?.find((candidate) => candidate.family === "IPv4" && !candidate.internal);
    if (address) return address.address;
  }
  return null;
}

function percent(value: number, total: number): number {
  return total > 0 ? round((value / total) * 100, 1) : 0;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function runText(command: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { shell: false, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), 2_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.once("error", () => {
      clearTimeout(timeout);
      resolve(null);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code === 0 ? stdout : null);
    });
  });
}
