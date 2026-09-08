import type { ActionResult, TouchBarStatus } from "@touchbar/protocol";
import type { AgentExecutor } from "./executors.js";
import { SystemMonitor, type AgentRuntimeStatus } from "./system-monitor.js";

export class StatusService {
  private status: TouchBarStatus = {
    connected: true,
    volume: null,
    muted: null,
    lastAction: null,
    system: null,
    timestamp: new Date().toISOString(),
  };
  private audioRefresh: Promise<void> | null = null;
  private systemRefresh: Promise<void> | null = null;

  public constructor(
    private readonly executor: AgentExecutor,
    private readonly monitor = new SystemMonitor(),
    private readonly runtimeStatus: () => AgentRuntimeStatus = () => ({ agentUptimeSeconds: 0, connectedClients: 0, actionCount: 0 }),
  ) {}

  public async snapshot(refreshAudio = true, refreshSystem = true, refreshAiUsage = false): Promise<TouchBarStatus> {
    // A slow CLI must never join the system/audio refresh promises.
    this.monitor.getAiUsage(refreshAiUsage);
    const refreshes: Promise<void>[] = [];
    if (refreshAudio) refreshes.push(this.refreshAudio());
    if (refreshSystem) refreshes.push(this.refreshSystem());
    await Promise.all(refreshes);
    return {
      ...this.status,
      system: this.status.system ? { ...this.status.system, aiDailyUsage: this.monitor.getAiUsage() } : null,
    };
  }

  public async close(): Promise<void> {
    await this.monitor.close();
  }

  public recordAction(action: ActionResult): TouchBarStatus {
    this.status = { ...this.status, lastAction: action, timestamp: new Date().toISOString() };
    return { ...this.status };
  }

  private refreshAudio(): Promise<void> {
    if (!this.audioRefresh) {
      this.audioRefresh = this.executor.getAudioStatus()
        .then((audio) => { this.status = { ...this.status, ...audio, timestamp: new Date().toISOString() }; })
        .finally(() => { this.audioRefresh = null; });
    }
    return this.audioRefresh;
  }

  private refreshSystem(): Promise<void> {
    if (!this.systemRefresh) {
      this.systemRefresh = this.monitor.snapshot(this.runtimeStatus())
        .then((system) => { this.status = { ...this.status, system, timestamp: new Date().toISOString() }; })
        .finally(() => { this.systemRefresh = null; });
    }
    return this.systemRefresh;
  }
}
