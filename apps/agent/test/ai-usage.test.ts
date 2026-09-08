import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  CcusageCommandRunner,
  CcusageDailyUsageCollector,
  parseCcusageReport,
  type CcusageRunner,
} from "../src/ai-usage.js";

const DATE = "2026-09-08";
const TIMEZONE = "Asia/Shanghai";

type ModelInput = {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cost?: number | null;
};

type AgentInput = { agent: string; models: ModelInput[]; cost?: number | null };

function modelRow(input: ModelInput) {
  const cacheReadTokens = input.cacheReadTokens ?? 0;
  const cacheCreationTokens = input.cacheCreationTokens ?? 0;
  return {
    modelName: input.modelName,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: input.inputTokens + input.outputTokens + cacheReadTokens + cacheCreationTokens,
    ...(input.cost === null ? {} : { cost: input.cost ?? 0 }),
    prompt: "must never be propagated",
    sessionPath: "/private/secret/session.jsonl",
  };
}

function sumRows(rows: Array<ReturnType<typeof modelRow>>) {
  return rows.reduce((total, row) => ({
    inputTokens: total.inputTokens + row.inputTokens,
    outputTokens: total.outputTokens + row.outputTokens,
    cacheReadTokens: total.cacheReadTokens + row.cacheReadTokens,
    cacheCreationTokens: total.cacheCreationTokens + row.cacheCreationTokens,
    totalTokens: total.totalTokens + row.totalTokens,
  }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0 });
}

function reportFor(agentsInput: AgentInput[], options: { date?: string; dailyCost?: number | null } = {}) {
  const agents = agentsInput.map((input) => {
    const modelBreakdowns = input.models.map(modelRow);
    const totals = sumRows(modelBreakdowns);
    return {
      agent: input.agent,
      ...totals,
      ...(input.cost === null ? {} : { totalCost: input.cost ?? modelBreakdowns.reduce((sum, row) => sum + (typeof row.cost === "number" ? row.cost : 0), 0) }),
      modelBreakdowns,
      modelsUsed: modelBreakdowns.map((row) => row.modelName),
      rawPrompt: "ignored",
    };
  });
  const totals = agents.reduce((total, agent) => ({
    inputTokens: total.inputTokens + agent.inputTokens,
    outputTokens: total.outputTokens + agent.outputTokens,
    cacheReadTokens: total.cacheReadTokens + agent.cacheReadTokens,
    cacheCreationTokens: total.cacheCreationTokens + agent.cacheCreationTokens,
    totalTokens: total.totalTokens + agent.totalTokens,
  }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0 });
  const modelBreakdowns = agents.flatMap((agent) => agent.modelBreakdowns);
  const derivedCost = agents.reduce((sum, agent) => sum + (agent.totalCost ?? 0), 0);
  const dailyCost = options.dailyCost === undefined ? derivedCost : options.dailyCost;
  const row = {
    agent: "all",
    period: options.date ?? DATE,
    ...totals,
    ...(dailyCost === null ? {} : { totalCost: dailyCost }),
    // This hierarchy overlaps agents and must be ignored by the parser.
    modelBreakdowns,
    agents,
    metadata: { agents: agents.map((agent) => agent.agent) },
    prompt: "ignored",
  };
  return {
    daily: [row],
    totals: { ...totals, ...(dailyCost === null ? {} : { totalCost: dailyCost }) },
    privateSessionPath: "/private/secret",
  };
}

function emptyReport() {
  return {
    daily: [],
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      totalCost: 0,
    },
  };
}

class DeferredRunner implements CcusageRunner {
  public readonly calls: Array<{ date: string; timezone: string }> = [];
  public closeCalls = 0;
  private pending: Array<{
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }> = [];

  public run(date: string, timezone: string): Promise<unknown> {
    this.calls.push({ date, timezone });
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  public resolve(value: unknown, index = 0): void {
    const pending = this.pending.splice(index, 1)[0];
    if (!pending) throw new Error("No pending run");
    pending.resolve(value);
  }

  public reject(reason: unknown, index = 0): void {
    const pending = this.pending.splice(index, 1)[0];
    if (!pending) throw new Error("No pending run");
    pending.reject(reason);
  }

  public async close(): Promise<void> {
    this.closeCalls += 1;
    for (const pending of this.pending.splice(0)) pending.reject(new Error("closed"));
  }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await delay(0);
}

describe("parseCcusageReport", () => {
  it("merges exact model names across sources without summing overlapping report levels", () => {
    const parsed = parseCcusageReport(reportFor([
      {
        agent: "codex",
        models: [
          { modelName: "gpt-5.6-sol", inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cost: 0.4 },
          { modelName: "gpt-5.6-terra", inputTokens: 40, outputTokens: 5, cost: 0.1 },
        ],
      },
      {
        agent: "claude-code",
        models: [
          { modelName: "gpt-5.6-sol", inputTokens: 20, outputTokens: 2, cacheCreationTokens: 8, cost: 0.2 },
          { modelName: "claude-opus-4-1", inputTokens: 30, outputTokens: 3, cost: 0.8 },
        ],
      },
    ]), DATE);

    expect(parsed.sources).toEqual(["claude-code", "codex"]);
    expect(parsed.totals).toEqual({
      inputTokens: 190,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheCreationTokens: 8,
      totalTokens: 268,
      costUsd: 1.5,
      costStatus: "estimated",
    });
    expect(parsed.models).toEqual([
      {
        model: "claude-opus-4-1",
        sources: ["claude-code"],
        inputTokens: 30,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 33,
        costUsd: 0.8,
        costStatus: "estimated",
      },
      {
        model: "gpt-5.6-sol",
        sources: ["claude-code", "codex"],
        inputTokens: 120,
        outputTokens: 12,
        cacheReadTokens: 50,
        cacheCreationTokens: 8,
        totalTokens: 190,
        costUsd: 0.6,
        costStatus: "estimated",
      },
      {
        model: "gpt-5.6-terra",
        sources: ["codex"],
        inputTokens: 40,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 45,
        costUsd: 0.1,
        costStatus: "estimated",
      },
    ]);
    expect(JSON.stringify(parsed)).not.toContain("secret");
    expect(JSON.stringify(parsed)).not.toContain("prompt");
  });

  it("derives model totalTokens when ccusage omits it from modelBreakdowns", () => {
    const report = reportFor([{ agent: "codex", models: [{ modelName: "gpt-5.6-sol", inputTokens: 7, outputTokens: 2, cacheReadTokens: 3, cost: 0.1 }] }]);
    delete (report.daily[0]!.agents[0]!.modelBreakdowns[0] as { totalTokens?: number }).totalTokens;
    const parsed = parseCcusageReport(report, DATE);
    expect(parsed.models[0]).toMatchObject({ model: "gpt-5.6-sol", totalTokens: 12 });
  });

  it("marks mixed known and unknown source costs partial, and sorts unknown models last", () => {
    const parsed = parseCcusageReport(reportFor([
      { agent: "codex", models: [{ modelName: "shared", inputTokens: 10, outputTokens: 1, cost: 0.25 }] },
      {
        agent: "claude-code",
        models: [
          { modelName: "shared", inputTokens: 20, outputTokens: 2, cost: 0 },
          { modelName: "unknown-only", inputTokens: 100, outputTokens: 5, cost: null },
        ],
      },
    ], { dailyCost: 0.25 }), DATE);

    expect(parsed.totals).toMatchObject({ costUsd: 0.25, costStatus: "partial" });
    expect(parsed.models.map((model) => model.model)).toEqual(["shared", "unknown-only"]);
    expect(parsed.models[0]).toMatchObject({ costUsd: 0.25, costStatus: "partial", sources: ["claude-code", "codex"] });
    expect(parsed.models[1]).toMatchObject({ costUsd: null, costStatus: "unknown" });
  });

  it("uses known model estimates when aggregate cost is zero but preserves partial truthfulness", () => {
    const parsed = parseCcusageReport(reportFor([
      {
        agent: "codex",
        cost: 0,
        models: [
          { modelName: "priced", inputTokens: 20, outputTokens: 2, cost: 0.3 },
          { modelName: "unpriced", inputTokens: 10, outputTokens: 1, cost: 0 },
        ],
      },
    ], { dailyCost: 0 }), DATE);
    expect(parsed.totals).toMatchObject({ costUsd: 0.3, costStatus: "partial" });
  });

  it("rejects finite model costs whose merged sum overflows", () => {
    const report = reportFor([
      { agent: "codex", models: [{ modelName: "shared", inputTokens: 1, outputTokens: 0, cost: Number.MAX_VALUE }] },
      { agent: "claude", models: [{ modelName: "shared", inputTokens: 1, outputTokens: 0, cost: Number.MAX_VALUE }] },
    ], { dailyCost: Number.MAX_VALUE });
    expect(() => parseCcusageReport(report, DATE)).toThrow("ccusage 费用超过安全范围");
  });

  it("returns a ready-compatible zero result only for a structurally valid empty report", () => {
    expect(parseCcusageReport(emptyReport(), DATE)).toEqual({
      totals: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        costStatus: "estimated",
      },
      models: [],
      sources: [],
    });
  });

  it.each([
    ["missing totals", { daily: [] }],
    ["wrong date", reportFor([], { date: "2026-09-07" })],
    ["nonempty totals without daily row", { daily: [], totals: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 1 } }],
    ["mismatched report totals", (() => { const value = reportFor([{ agent: "codex", models: [{ modelName: "m", inputTokens: 1, outputTokens: 0 }] }]); value.totals.totalTokens = 2; return value; })()],
    ["mismatched source totals", (() => { const value = reportFor([{ agent: "codex", models: [{ modelName: "m", inputTokens: 1, outputTokens: 0 }] }]); value.daily[0]!.agents[0]!.inputTokens = 2; return value; })()],
    ["negative count", (() => { const value = reportFor([{ agent: "codex", models: [{ modelName: "m", inputTokens: 1, outputTokens: 0 }] }]); value.daily[0]!.agents[0]!.modelBreakdowns[0]!.inputTokens = -1; return value; })()],
    ["missing source detail", { daily: [{ period: DATE, inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 1, agents: [] }], totals: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 1 } }],
  ])("rejects malformed or inconsistent input: %s", (_label, report) => {
    expect(() => parseCcusageReport(report, DATE)).toThrow(/ccusage/);
  });
});

describe("CcusageDailyUsageCollector", () => {
  it("returns immediately, does not refresh when false, and uses local date/timezone when requested", async () => {
    const runner = new DeferredRunner();
    const now = new Date("2026-09-07T16:30:00.000Z");
    const collector = new CcusageDailyUsageCollector({ runner, now: () => now, timezone: () => TIMEZONE });

    const initial = collector.snapshot(false);
    expect(initial).toMatchObject({ date: DATE, timezone: TIMEZONE, status: "loading", totals: null, nextRefreshAt: null });
    expect(runner.calls).toEqual([]);

    const refreshing = collector.snapshot(true);
    expect(refreshing.status).toBe("loading");
    expect(runner.calls).toEqual([{ date: DATE, timezone: TIMEZONE }]);
    expect(refreshing.nextRefreshAt).toBe("2026-09-07T16:40:00.000Z");
    runner.resolve(emptyReport());
    await flush();
    expect(collector.snapshot()).toMatchObject({ status: "ready", totals: { totalTokens: 0 }, lastSuccessfulRefreshAt: now.toISOString() });
    await collector.close();
  });

  it("keeps revisions stable between state changes and protects snapshots from mutation", async () => {
    const runner = new DeferredRunner();
    const now = new Date("2026-09-08T02:00:00.000Z");
    const collector = new CcusageDailyUsageCollector({ runner, now: () => now, timezone: () => TIMEZONE });
    const first = collector.snapshot();
    const second = collector.snapshot();
    expect(second.revision).toBe(first.revision);

    const refreshing = collector.snapshot(true);
    expect(refreshing.revision).not.toBe(first.revision);
    expect(collector.snapshot().revision).toBe(refreshing.revision);
    runner.resolve(reportFor([{ agent: "codex", models: [{ modelName: "m", inputTokens: 1, outputTokens: 0, cost: 0.1 }] }]));
    await flush();
    const ready = collector.snapshot();
    expect(ready.revision).not.toBe(refreshing.revision);
    ready.models[0]!.sources.push("mutated");
    expect(collector.snapshot().models[0]!.sources).toEqual(["codex"]);
    await collector.close();
  });

  it("enforces a ten-minute cooldown and a single flight for many callers", async () => {
    const runner = new DeferredRunner();
    let now = new Date("2026-09-08T02:00:00.000Z");
    const collector = new CcusageDailyUsageCollector({ runner, now: () => now, timezone: () => TIMEZONE });

    collector.snapshot(true);
    collector.snapshot(true);
    collector.snapshot(true);
    expect(runner.calls).toHaveLength(1);
    runner.resolve(emptyReport());
    await flush();

    now = new Date("2026-09-08T02:09:59.999Z");
    collector.snapshot(true);
    expect(runner.calls).toHaveLength(1);
    now = new Date("2026-09-08T02:10:00.000Z");
    collector.snapshot(true);
    expect(runner.calls).toHaveLength(2);
    runner.resolve(emptyReport());
    await flush();
    await collector.close();
  });

  it("retains same-day successful data as stale after failure, but first failure has null totals", async () => {
    const runner = new DeferredRunner();
    let now = new Date("2026-09-08T02:00:00.000Z");
    const collector = new CcusageDailyUsageCollector({ runner, now: () => now, timezone: () => TIMEZONE });

    collector.snapshot(true);
    runner.reject(new Error("/private/secret/raw output"));
    await flush();
    expect(collector.snapshot()).toMatchObject({ status: "error", totals: null, error: "ccusage 采集失败" });
    expect(collector.snapshot().error).not.toContain("secret");

    now = new Date("2026-09-08T02:10:00.000Z");
    collector.snapshot(true);
    runner.resolve(reportFor([{ agent: "codex", models: [{ modelName: "m", inputTokens: 5, outputTokens: 1, cost: 0.1 }] }]));
    await flush();
    const ready = collector.snapshot();
    expect(ready.status).toBe("ready");

    now = new Date("2026-09-08T02:20:00.000Z");
    collector.snapshot(true);
    runner.reject(new Error("broken"));
    await flush();
    expect(collector.snapshot()).toMatchObject({
      status: "stale",
      totals: { totalTokens: 6 },
      lastSuccessfulRefreshAt: ready.lastSuccessfulRefreshAt,
      error: "ccusage 采集失败",
    });
    await collector.close();
  });

  it("invalidates data immediately on local midnight and discards an old-day in-flight result", async () => {
    const runner = new DeferredRunner();
    let now = new Date("2026-09-08T15:59:59.000Z"); // 23:59:59 Shanghai
    const collector = new CcusageDailyUsageCollector({ runner, now: () => now, timezone: () => TIMEZONE });
    collector.snapshot(true);
    expect(runner.calls[0]!.date).toBe("2026-09-08");

    now = new Date("2026-09-08T16:00:01.000Z"); // next local day
    const nextDay = collector.snapshot(false);
    expect(nextDay).toMatchObject({ date: "2026-09-09", status: "loading", totals: null });
    expect(runner.calls).toHaveLength(1);

    collector.snapshot(true);
    expect(runner.calls).toHaveLength(1);
    runner.resolve(reportFor([{ agent: "codex", models: [{ modelName: "old", inputTokens: 10, outputTokens: 1, cost: 0.1 }] }], { date: "2026-09-08" }));
    await flush();
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]).toEqual({ date: "2026-09-09", timezone: TIMEZONE });
    expect(collector.snapshot()).toMatchObject({ date: "2026-09-09", status: "loading", totals: null });

    runner.resolve(emptyReport());
    await flush();
    expect(collector.snapshot()).toMatchObject({ date: "2026-09-09", status: "ready", totals: { totalTokens: 0 } });
    await collector.close();
  });

  it("invalidates immediately when timezone changes and close cancels/prevents work", async () => {
    const runner = new DeferredRunner();
    let timezone = "UTC";
    const now = new Date("2026-09-08T23:30:00.000Z");
    const collector = new CcusageDailyUsageCollector({ runner, now: () => now, timezone: () => timezone });
    collector.snapshot(true);
    timezone = TIMEZONE;
    expect(collector.snapshot(false)).toMatchObject({ date: "2026-09-09", timezone: TIMEZONE, totals: null });
    await collector.close();
    expect(runner.closeCalls).toBe(1);
    collector.snapshot(true);
    expect(runner.calls).toHaveLength(1);
  });
});

describe("CcusageCommandRunner", () => {
  async function script(source: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "touchbar-ccusage-runner-"));
    const path = join(directory, "fake-cli.mjs");
    await writeFile(path, source);
    await chmod(path, 0o755);
    return path;
  }

  it("uses fixed arguments and parses JSON without a shell", async () => {
    const cliPath = await script(`process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));`);
    const runner = new CcusageCommandRunner({ cliPath, timeoutMs: 2_000 });
    await expect(runner.run(DATE, TIMEZONE)).resolves.toEqual({
      argv: ["daily", "--json", "--by-agent", "--since", DATE, "--until", DATE, "--timezone", TIMEZONE],
    });
    await runner.close();
  });

  it.each([
    ["malformed JSON", `process.stdout.write("not-json");`, "ccusage 返回了无效 JSON"],
    ["nonzero exit", `console.error("/private/secret/output"); process.exit(7);`, "ccusage 执行失败"],
    ["stdout overflow", `process.stdout.write("x".repeat(4096)); setInterval(() => {}, 1000);`, "ccusage 输出超过安全限制"],
    ["stderr overflow", `process.stderr.write("x".repeat(4096)); setInterval(() => {}, 1000);`, "ccusage 错误输出超过安全限制"],
  ])("returns a sanitized error for %s", async (_label, source, expected) => {
    const cliPath = await script(source);
    const runner = new CcusageCommandRunner({ cliPath, timeoutMs: 2_000, maxStdoutBytes: 128, maxStderrBytes: 128, killGraceMs: 20 });
    await expect(runner.run(DATE, TIMEZONE)).rejects.toThrow(expected);
    await runner.close();
  });

  it("kills the entire detached process group on timeout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "touchbar-ccusage-group-"));
    const heartbeat = join(directory, "heartbeat.txt");
    const childSource = `
      import { appendFileSync } from "node:fs";
      process.on("SIGTERM", () => {});
      setInterval(() => appendFileSync(${JSON.stringify(heartbeat)}, "x"), 15);
    `;
    const cliPath = await script(`
      import { spawn } from "node:child_process";
      spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(childSource)}], { stdio: "ignore" });
      setInterval(() => {}, 1000);
    `);
    // The assertion concerns cleanup, not how quickly two Node processes start
    // while the full workspace suite is competing for CPU.
    const runner = new CcusageCommandRunner({ cliPath, timeoutMs: 2_500, killGraceMs: 20 });
    const running = runner.run(DATE, TIMEZONE);
    // Attach a rejection handler immediately, including if the readiness assertion fails.
    void running.catch(() => {});
    try {
      await expect.poll(async () => existsSync(heartbeat) ? (await stat(heartbeat)).size : 0, {
        timeout: 2_000, interval: 20,
      }).toBeGreaterThan(0);
      await expect(running).rejects.toThrow("ccusage 采集超时");
      const firstSize = (await stat(heartbeat)).size;
      await delay(100);
      const secondSize = (await stat(heartbeat)).size;
      expect(firstSize).toBeGreaterThan(0);
      expect(secondSize).toBe(firstSize);
    } finally {
      await runner.close();
      await running.catch(() => {});
    }
  });

  it("close waits for SIGKILL cleanup of a detached SIGTERM-ignoring grandchild", async () => {
    const directory = await mkdtemp(join(tmpdir(), "touchbar-ccusage-close-"));
    const marker = join(directory, "started.txt");
    const heartbeat = join(directory, "heartbeat.txt");
    const childSource = `
      import { appendFileSync } from "node:fs";
      process.on("SIGTERM", () => {});
      setInterval(() => appendFileSync(${JSON.stringify(heartbeat)}, "x"), 10);
    `;
    const cliPath = await script(`
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(childSource)}], { stdio: "ignore" });
      writeFileSync(${JSON.stringify(marker)}, "started");
      setInterval(() => {}, 1000);
    `);
    const killGraceMs = 80;
    const runner = new CcusageCommandRunner({ cliPath, timeoutMs: 5_000, killGraceMs });
    const running = runner.run(DATE, TIMEZONE);
    void running.catch(() => {});
    try {
      await expect.poll(() => existsSync(marker) && existsSync(heartbeat), {
        timeout: 2_000, interval: 20,
      }).toBe(true);
      expect(readFileSync(marker, "utf8")).toBe("started");
      const closeStartedAt = Date.now();
      await runner.close();
      expect(Date.now() - closeStartedAt).toBeGreaterThanOrEqual(killGraceMs - 10);
      await expect(running).rejects.toThrow("ccusage 采集器已关闭");
      const sizeAfterClose = (await stat(heartbeat)).size;
      expect(sizeAfterClose).toBeGreaterThan(0);
      await delay(80);
      expect((await stat(heartbeat)).size).toBe(sizeAfterClose);
      await expect(runner.run(DATE, TIMEZONE)).rejects.toThrow("ccusage 采集器已关闭");
    } finally {
      await runner.close();
      await running.catch(() => {});
    }
  });
});

