import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { AiDailyUsage, AiModelUsage, AiUsageTotals } from "@touchbar/protocol";

const CCUSAGE_VERSION = "20.0.20";
const DEFAULT_REFRESH_INTERVAL_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_KILL_GRACE_MS = 150;

export interface AiUsageCollector {
  snapshot(refresh?: boolean): AiDailyUsage;
  close(): Promise<void>;
}

export interface CcusageRunner {
  run(date: string, timezone: string): Promise<unknown>;
  close(): Promise<void>;
}

export interface CcusageCommandRunnerOptions {
  cliPath?: string;
  execPath?: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  killGraceMs?: number;
}

interface RunningCommand {
  child: ChildProcessByStdio<null, Readable, Readable>;
  done: Promise<void>;
  finishDone: () => void;
  closeObserved: Promise<void>;
  finishCloseObserved: () => void;
  finishTermination: () => void;
  terminationReason: RunnerError | null;
  terminationCleanup: Promise<void> | null;
  timeout: NodeJS.Timeout | null;
}

class RunnerError extends Error {}
class ReportError extends Error {}

/** Runs the locally installed, pinned ccusage package without a shell or npx. */
export class CcusageCommandRunner implements CcusageRunner {
  private readonly configuredCliPath: string | undefined;
  private readonly execPath: string;
  private readonly timeoutMs: number;
  private readonly maxStdoutBytes: number;
  private readonly maxStderrBytes: number;
  private readonly killGraceMs: number;
  private readonly commands = new Set<RunningCommand>();
  private closed = false;

  public constructor(options: CcusageCommandRunnerOptions = {}) {
    this.configuredCliPath = options.cliPath;
    this.execPath = options.execPath ?? process.execPath;
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxStdoutBytes = positiveInteger(options.maxStdoutBytes, DEFAULT_MAX_STDOUT_BYTES);
    this.maxStderrBytes = positiveInteger(options.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES);
    this.killGraceMs = positiveInteger(options.killGraceMs, DEFAULT_KILL_GRACE_MS);
  }

  public async run(date: string, timezone: string): Promise<unknown> {
    if (this.closed) throw new RunnerError("ccusage 采集器已关闭");

    const cliPath = this.resolveCliPath();
    const args = [
      cliPath,
      "daily",
      "--json",
      "--by-agent",
      "--since",
      date,
      "--until",
      date,
      "--timezone",
      timezone,
    ];

    return await new Promise<unknown>((resolve, reject) => {
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = spawn(this.execPath, args, {
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        reject(new RunnerError("ccusage 启动失败"));
        return;
      }

      let finishDone!: () => void;
      const done = new Promise<void>((doneResolve) => { finishDone = doneResolve; });
      let finishCloseObserved!: () => void;
      const closeObserved = new Promise<void>((closeResolve) => { finishCloseObserved = closeResolve; });
      const command: RunningCommand = {
        child,
        done,
        finishDone,
        closeObserved,
        finishCloseObserved,
        finishTermination: () => {},
        terminationReason: null,
        terminationCleanup: null,
        timeout: null,
      };
      this.commands.add(command);

      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const finish = (error?: Error, value?: unknown): void => {
        if (settled) return;
        settled = true;
        if (command.timeout) clearTimeout(command.timeout);
        this.commands.delete(command);
        command.finishDone();
        if (error) reject(error);
        else resolve(value);
      };
      command.finishTermination = () => finish(command.terminationReason ?? new RunnerError("ccusage 进程被中断"));

      command.timeout = setTimeout(() => {
        this.terminate(command, new RunnerError("ccusage 采集超时"));
      }, this.timeoutMs);
      command.timeout.unref();

      child.stdout.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += buffer.length;
        if (stdoutBytes > this.maxStdoutBytes) {
          this.terminate(command, new RunnerError("ccusage 输出超过安全限制"));
          return;
        }
        stdout.push(buffer);
      });

      // Stderr is deliberately discarded. Tracking a bound prevents an untrusted CLI
      // failure from retaining arbitrary diagnostics, paths, or session details.
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > this.maxStderrBytes) {
          this.terminate(command, new RunnerError("ccusage 错误输出超过安全限制"));
        }
      });

      child.once("error", () => {
        if (command.terminationReason) {
          command.finishCloseObserved();
          return;
        }
        finish(new RunnerError("ccusage 启动失败"));
      });
      child.once("close", (code, signal) => {
        command.finishCloseObserved();
        // A terminated launcher may close before its SIGTERM-ignoring descendants.
        // The tracked cleanup owns settlement until the whole group receives SIGKILL.
        if (command.terminationReason) return;
        if (code !== 0) {
          finish(new RunnerError(signal ? "ccusage 进程被中断" : "ccusage 执行失败"));
          return;
        }
        const text = Buffer.concat(stdout, stdoutBytes).toString("utf8").trim();
        try {
          finish(undefined, JSON.parse(text));
        } catch {
          finish(new RunnerError("ccusage 返回了无效 JSON"));
        }
      });
    });
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const commands = [...this.commands];
    for (const command of commands) {
      this.terminate(command, new RunnerError("ccusage 采集器已关闭"));
    }
    await Promise.all(commands.map((command) => command.done));
  }

  private resolveCliPath(): string {
    if (this.configuredCliPath) return this.configuredCliPath;
    try {
      return createRequire(import.meta.url).resolve("ccusage/src/cli.js");
    } catch {
      throw new RunnerError("ccusage 依赖未安装");
    }
  }

  private terminate(command: RunningCommand, reason: RunnerError): void {
    if (command.terminationReason) return;
    command.terminationReason = reason;
    signalProcessGroup(command.child, "SIGTERM");
    command.terminationCleanup = this.finishProcessGroup(command);
    void command.terminationCleanup.then(command.finishTermination);
  }

  private async finishProcessGroup(command: RunningCommand): Promise<void> {
    // Keep this grace timer referenced: close() must not resolve (and Node must not exit)
    // before the native descendant process group has received the final SIGKILL.
    await wait(this.killGraceMs);
    signalProcessGroup(command.child, "SIGKILL");
    // Wait for the process group to disappear, not merely for the launcher to close.
    // The poll is bounded and fully awaited, so no timer can target a recycled PID later.
    await waitForProcessGroupExit(command, this.killGraceMs);
  }
}

export interface CcusageDailyUsageCollectorOptions {
  runner?: CcusageRunner;
  now?: () => Date;
  timezone?: () => string;
  refreshIntervalMs?: number;
}

interface Scope {
  date: string;
  timezone: string;
  key: string;
}

/**
 * Synchronous snapshot facade over an asynchronous ccusage process.
 * Calling snapshot(true) only schedules work; it never waits for the CLI.
 */
export class CcusageDailyUsageCollector implements AiUsageCollector {
  private readonly runner: CcusageRunner;
  private readonly now: () => Date;
  private readonly timezone: () => string;
  private readonly refreshIntervalMs: number;
  private readonly instanceId = randomUUID();
  private revision = 0;
  private state: AiDailyUsage;
  private scopeKey: string;
  private attemptStartedAt: number | null = null;
  private attemptScopeKey: string | null = null;
  private inFlight: Promise<void> | null = null;
  private pendingRefresh = false;
  private closed = false;

  public constructor(options: CcusageDailyUsageCollectorOptions = {}) {
    this.runner = options.runner ?? new CcusageCommandRunner();
    this.now = options.now ?? (() => new Date());
    this.timezone = options.timezone ?? defaultTimezone;
    this.refreshIntervalMs = positiveInteger(options.refreshIntervalMs, DEFAULT_REFRESH_INTERVAL_MS);
    const scope = this.currentScope();
    this.scopeKey = scope.key;
    this.state = this.emptyState(scope);
  }

  public snapshot(refresh = false): AiDailyUsage {
    const scope = this.currentScope();
    if (scope.key !== this.scopeKey) this.resetScope(scope);
    if (refresh && !this.closed) this.requestRefresh(scope);
    return cloneUsage(this.state);
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pendingRefresh = false;
    const flight = this.inFlight;
    await this.runner.close();
    if (flight) await flight;
  }

  private requestRefresh(scope: Scope): void {
    if (this.inFlight) {
      if (this.attemptScopeKey !== scope.key) this.pendingRefresh = true;
      return;
    }
    const nowMs = this.now().getTime();
    if (
      this.attemptScopeKey === scope.key
      && this.attemptStartedAt !== null
      && nowMs < this.attemptStartedAt + this.refreshIntervalMs
    ) return;
    this.startRefresh(scope, nowMs);
  }

  private startRefresh(scope: Scope, attemptStartedAt: number): void {
    if (this.closed || this.inFlight) return;
    this.attemptScopeKey = scope.key;
    this.attemptStartedAt = attemptStartedAt;
    this.pendingRefresh = false;
    this.mutate({
      status: this.state.totals ? this.state.status : "loading",
      nextRefreshAt: new Date(attemptStartedAt + this.refreshIntervalMs).toISOString(),
    });

    let execution: Promise<unknown>;
    try {
      execution = Promise.resolve(this.runner.run(scope.date, scope.timezone));
    } catch (error) {
      execution = Promise.reject(error);
    }
    const run = execution
      .then((report) => this.applySuccess(scope, report))
      .catch((error: unknown) => this.applyFailure(scope, error))
      .finally(() => {
        this.inFlight = null;
        if (!this.closed && this.pendingRefresh) {
          const current = this.currentScope();
          if (current.key !== this.scopeKey) this.resetScope(current);
          this.requestRefresh(current);
        }
      });
    this.inFlight = run;
  }

  private applySuccess(scope: Scope, report: unknown): void {
    if (this.closed || !this.scopeStillCurrent(scope)) return;
    let parsed: ReturnType<typeof parseCcusageReport>;
    try {
      parsed = parseCcusageReport(report, scope.date);
    } catch (error) {
      this.applyFailure(scope, error);
      return;
    }
    const completedAt = this.now();
    if (!this.scopeStillCurrent(scope, completedAt)) return;
    this.mutate({
      status: "ready",
      lastSuccessfulRefreshAt: completedAt.toISOString(),
      error: null,
      totals: parsed.totals,
      models: parsed.models,
      sources: parsed.sources,
    });
  }

  private applyFailure(scope: Scope, error: unknown): void {
    if (this.closed || !this.scopeStillCurrent(scope)) return;
    const message = sanitizeCollectorError(error);
    this.mutate({
      status: this.state.totals ? "stale" : "error",
      error: message,
    });
  }

  private scopeStillCurrent(scope: Scope, instant = this.now()): boolean {
    const current = scopeFor(instant, this.timezone());
    return this.scopeKey === scope.key && current.key === scope.key;
  }

  private resetScope(scope: Scope): void {
    this.scopeKey = scope.key;
    this.attemptScopeKey = null;
    this.attemptStartedAt = null;
    this.pendingRefresh = false;
    this.state = this.emptyState(scope);
  }

  private emptyState(scope: Scope): AiDailyUsage {
    return {
      revision: this.nextRevision(),
      date: scope.date,
      timezone: scope.timezone,
      currency: "USD",
      collector: "ccusage",
      collectorVersion: CCUSAGE_VERSION,
      status: "loading",
      lastSuccessfulRefreshAt: null,
      nextRefreshAt: null,
      error: null,
      totals: null,
      models: [],
      sources: [],
    };
  }

  private mutate(patch: Partial<AiDailyUsage>): void {
    this.state = { ...this.state, ...patch, revision: this.nextRevision() };
  }

  private nextRevision(): string {
    this.revision += 1;
    return `${this.instanceId}:${this.revision}`;
  }

  private currentScope(): Scope {
    return scopeFor(this.now(), this.timezone());
  }
}

export function parseCcusageReport(
  report: unknown,
  date: string,
): { totals: AiUsageTotals; models: AiModelUsage[]; sources: string[] } {
  const root = objectValue(report, "ccusage 报告格式无效");
  const daily = arrayValue(root.daily, "ccusage 日报格式无效");
  const reportTotals = tokenRecord(root.totals, "ccusage 总计格式无效");

  if (daily.length === 0) {
    if (!isZeroTokens(reportTotals)) throw new ReportError("ccusage 日报缺少当天数据");
    return { totals: finalizedTotals(reportTotals, false, false), models: [], sources: [] };
  }

  const rows = daily.map((value) => objectValue(value, "ccusage 日报条目格式无效"));
  if (rows.some((row) => row.period !== date)) throw new ReportError("ccusage 返回的日期与请求日期不一致");
  if (rows.length !== 1) throw new ReportError("ccusage 当天报告包含重复汇总");

  const row = rows[0]!;
  const dailyTotals = tokenRecord(row, "ccusage 当天总计格式无效");
  assertSameTokens(reportTotals, dailyTotals, "ccusage 总计与当天数据不一致");

  const agents = arrayValue(row.agents, "ccusage 来源明细格式无效");
  if (agents.length === 0 && dailyTotals.totalTokens > 0) {
    throw new ReportError("ccusage 当天报告缺少来源明细");
  }

  const sourceNames = new Set<string>();
  const sourceTokenSum = zeroTokenNumbers();
  const mergedModels = new Map<string, ModelAccumulator>();

  for (const agentValue of agents) {
    const agent = objectValue(agentValue, "ccusage 来源条目格式无效");
    const source = nonEmptyString(agent.agent, "ccusage 来源名称无效");
    if (sourceNames.has(source)) throw new ReportError("ccusage 来源明细重复");
    sourceNames.add(source);

    const agentTotals = tokenRecord(agent, "ccusage 来源总计格式无效");
    addTokenNumbers(sourceTokenSum, agentTotals);
    const breakdowns = arrayValue(agent.modelBreakdowns, "ccusage 模型明细格式无效");
    if (breakdowns.length === 0 && agentTotals.totalTokens > 0) {
      throw new ReportError("ccusage 来源缺少模型明细");
    }

    const modelTokenSum = zeroTokenNumbers();
    for (const breakdownValue of breakdowns) {
      const breakdown = objectValue(breakdownValue, "ccusage 模型条目格式无效");
      const model = nonEmptyString(breakdown.modelName, "ccusage 模型名称无效");
      const modelTotals = tokenRecord(breakdown, "ccusage 模型统计格式无效", true);
      addTokenNumbers(modelTokenSum, modelTotals);

      const knownCost = modelTotals.cost !== null && modelTotals.cost > 0;
      const unknownCost = modelTotals.totalTokens > 0 && !knownCost;
      const accumulator = mergedModels.get(model) ?? {
        ...zeroTokenNumbers(),
        model,
        sources: new Set<string>(),
        knownCost: 0,
        hasKnownCost: false,
        hasUnknownCost: false,
      };
      addTokenNumbers(accumulator, modelTotals);
      accumulator.sources.add(source);
      if (knownCost) {
        accumulator.knownCost = safeAddCost(accumulator.knownCost, modelTotals.cost!);
        accumulator.hasKnownCost = true;
      }
      if (unknownCost) accumulator.hasUnknownCost = true;
      mergedModels.set(model, accumulator);
    }

    assertSameTokens(modelTokenSum, agentTotals, "ccusage 模型明细与来源总计不一致");
  }

  assertSameTokens(sourceTokenSum, dailyTotals, "ccusage 来源明细与当天总计不一致");
  validateMetadataSources(row.metadata ?? root.metadata, sourceNames);

  const models = [...mergedModels.values()].map(finalizeModel);
  models.sort(compareModels);

  const knownModelCost = models.reduce((sum, model) => safeAddCost(sum, model.costUsd ?? 0), 0);
  const hasKnownModelCost = models.some((model) => model.costUsd !== null && model.costUsd > 0);
  const hasUnknownModelCost = models.some((model) => model.costStatus !== "estimated");
  return {
    totals: finalizedTotals(dailyTotals, hasKnownModelCost, hasUnknownModelCost, knownModelCost),
    models,
    sources: [...sourceNames].sort((left, right) => left.localeCompare(right)),
  };
}

interface TokenNumbers {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
}

interface ParsedTokenRecord extends TokenNumbers {
  cost: number | null;
}

interface ModelAccumulator extends TokenNumbers {
  model: string;
  sources: Set<string>;
  knownCost: number;
  hasKnownCost: boolean;
  hasUnknownCost: boolean;
}

function tokenRecord(value: unknown, message: string, allowDerivedTotal = false): ParsedTokenRecord {
  const record = objectValue(value, message);
  const inputTokens = countValue(record.inputTokens, message);
  const outputTokens = countValue(record.outputTokens, message);
  const cacheReadTokens = countValue(record.cacheReadTokens, message);
  const cacheCreationTokens = countValue(record.cacheCreationTokens, message);
  const calculated = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
  if (!Number.isSafeInteger(calculated)) throw new ReportError(message);
  const totalTokens = allowDerivedTotal && record.totalTokens === undefined
    ? calculated
    : countValue(record.totalTokens, message);
  if (calculated !== totalTokens) throw new ReportError(message);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    cost: optionalCost(record.totalCost ?? record.cost, message),
  };
}

function finalizedTotals(
  record: ParsedTokenRecord,
  hasKnownCost: boolean,
  hasUnknownCost: boolean,
  knownCost = 0,
): AiUsageTotals {
  const cost = costResult(record, hasKnownCost, hasUnknownCost, knownCost);
  return {
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheReadTokens: record.cacheReadTokens,
    cacheCreationTokens: record.cacheCreationTokens,
    totalTokens: record.totalTokens,
    ...cost,
  };
}

function finalizeModel(model: ModelAccumulator): AiModelUsage {
  let costUsd: number | null;
  let costStatus: AiUsageTotals["costStatus"];
  if (model.hasUnknownCost && model.hasKnownCost) {
    costUsd = normalizedCost(model.knownCost);
    costStatus = "partial";
  } else if (model.hasUnknownCost) {
    costUsd = null;
    costStatus = "unknown";
  } else {
    costUsd = normalizedCost(model.knownCost);
    costStatus = "estimated";
  }
  return {
    model: model.model,
    sources: [...model.sources].sort((left, right) => left.localeCompare(right)),
    inputTokens: model.inputTokens,
    outputTokens: model.outputTokens,
    cacheReadTokens: model.cacheReadTokens,
    cacheCreationTokens: model.cacheCreationTokens,
    totalTokens: model.totalTokens,
    costUsd,
    costStatus,
  };
}

function costResult(
  record: ParsedTokenRecord,
  hasKnownCost: boolean,
  hasUnknownCost: boolean,
  knownCost: number,
): Pick<AiUsageTotals, "costUsd" | "costStatus"> {
  if (record.totalTokens === 0) return { costUsd: 0, costStatus: "estimated" };
  const reportedCost = record.cost !== null && record.cost > 0 ? record.cost : null;
  const bestKnownCost = reportedCost ?? (hasKnownCost ? normalizedCost(knownCost) : null);
  if (hasUnknownCost) {
    return bestKnownCost === null
      ? { costUsd: null, costStatus: "unknown" }
      : { costUsd: bestKnownCost, costStatus: "partial" };
  }
  if (bestKnownCost !== null) return { costUsd: bestKnownCost, costStatus: "estimated" };
  return { costUsd: null, costStatus: "unknown" };
}


function normalizedCost(value: number): number {
  return Number(value.toFixed(12));
}

function validateMetadataSources(metadataValue: unknown, sources: Set<string>): void {
  if (metadataValue === undefined) return;
  const metadata = objectValue(metadataValue, "ccusage 元数据格式无效");
  if (metadata.agents === undefined) return;
  const agents = arrayValue(metadata.agents, "ccusage 元数据来源格式无效")
    .map((value) => nonEmptyString(value, "ccusage 元数据来源格式无效"));
  const metadataSources = [...new Set(agents)].sort();
  const actualSources = [...sources].sort();
  if (metadataSources.length !== agents.length || metadataSources.join("\0") !== actualSources.join("\0")) {
    throw new ReportError("ccusage 元数据来源与明细不一致");
  }
}

function compareModels(left: AiModelUsage, right: AiModelUsage): number {
  const leftKnown = left.costUsd !== null;
  const rightKnown = right.costUsd !== null;
  if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
  if (leftKnown && rightKnown && left.costUsd !== right.costUsd) return right.costUsd! - left.costUsd!;
  if (left.totalTokens !== right.totalTokens) return right.totalTokens - left.totalTokens;
  return left.model.localeCompare(right.model);
}

function objectValue(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReportError(message);
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, message: string): unknown[] {
  if (!Array.isArray(value)) throw new ReportError(message);
  return value;
}

function nonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ReportError(message);
  return value.trim();
}

function countValue(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ReportError(message);
  return value;
}

function optionalCost(value: unknown, message: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new ReportError(message);
  return value;
}

function zeroTokenNumbers(): TokenNumbers {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0 };
}

function addTokenNumbers(target: TokenNumbers, source: TokenNumbers): void {
  target.inputTokens = safeAdd(target.inputTokens, source.inputTokens);
  target.outputTokens = safeAdd(target.outputTokens, source.outputTokens);
  target.cacheReadTokens = safeAdd(target.cacheReadTokens, source.cacheReadTokens);
  target.cacheCreationTokens = safeAdd(target.cacheCreationTokens, source.cacheCreationTokens);
  target.totalTokens = safeAdd(target.totalTokens, source.totalTokens);
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new ReportError("ccusage Token 数量超过安全范围");
  return result;
}

function safeAddCost(left: number, right: number): number {
  const result = left + right;
  if (!Number.isFinite(result) || result < 0) throw new ReportError("ccusage 费用超过安全范围");
  return result;
}

function assertSameTokens(left: TokenNumbers, right: TokenNumbers, message: string): void {
  if (
    left.inputTokens !== right.inputTokens
    || left.outputTokens !== right.outputTokens
    || left.cacheReadTokens !== right.cacheReadTokens
    || left.cacheCreationTokens !== right.cacheCreationTokens
    || left.totalTokens !== right.totalTokens
  ) throw new ReportError(message);
}

function isZeroTokens(value: TokenNumbers): boolean {
  return value.inputTokens === 0
    && value.outputTokens === 0
    && value.cacheReadTokens === 0
    && value.cacheCreationTokens === 0
    && value.totalTokens === 0;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForProcessGroupExit(command: RunningCommand, timeoutMs: number): Promise<void> {
  const groupId = command.child.pid;
  if (!groupId || process.platform === "win32") {
    await waitForPromise(command.closeObserved, timeoutMs);
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(groupId)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await wait(Math.min(10, remaining));
  }
}

async function waitForPromise(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  await Promise.race([promise, timeout]);
  if (timer) clearTimeout(timer);
}

function processGroupExists(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return !isErrnoException(error) || error.code !== "ESRCH";
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function signalProcessGroup(child: ChildProcessByStdio<null, Readable, Readable>, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through when the process group has already exited.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Process already exited.
  }
}

function sanitizeCollectorError(error: unknown): string {
  if (error instanceof RunnerError || error instanceof ReportError) return error.message;
  return "ccusage 采集失败";
}

function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function scopeFor(instant: Date, timezone: string): Scope {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
  } catch {
    throw new Error("无效的系统时区");
  }
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error("无法确定本地日期");
  const date = `${year}-${month}-${day}`;
  return { date, timezone, key: `${date}\0${timezone}` };
}

function cloneUsage(value: AiDailyUsage): AiDailyUsage {
  return {
    ...value,
    totals: value.totals ? { ...value.totals } : null,
    models: value.models.map((model) => ({ ...model, sources: [...model.sources] })),
    sources: [...value.sources],
  };
}
