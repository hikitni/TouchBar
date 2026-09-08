import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CodexDailyUsage, CodexModelUsage, CodexUsageTotals } from "@touchbar/protocol";

interface UsageRecord {
  responseId: string;
  turnId: string | null;
  usage: Omit<CodexUsageTotals, "calls">;
}

interface FileState {
  inode: number;
  offset: number;
  remainder: Buffer;
  turnModels: Map<string, string>;
  records: Map<string, UsageRecord>;
}

export interface CodexDailyUsageCollectorOptions {
  codexHome: string;
  now?: () => Date;
}

export class CodexDailyUsageCollector {
  private readonly codexHome: string;
  private readonly now: () => Date;
  private date = "";
  private files = new Map<string, FileState>();

  public constructor(options: CodexDailyUsageCollectorOptions) {
    this.codexHome = options.codexHome;
    this.now = options.now ?? (() => new Date());
  }

  public async snapshot(): Promise<CodexDailyUsage> {
    const current = this.now();
    const date = localDateKey(current);
    if (date !== this.date) {
      this.date = date;
      this.files.clear();
    }

    const dayDirectory = join(
      this.codexHome,
      "sessions",
      String(current.getFullYear()),
      String(current.getMonth() + 1).padStart(2, "0"),
      String(current.getDate()).padStart(2, "0"),
    );

    let paths: string[] = [];
    try {
      const entries = await readdir(dayDirectory, { withFileTypes: true });
      paths = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => join(dayDirectory, entry.name))
        .sort();
    } catch {
      this.files.clear();
      return emptyUsage(date, current.toISOString());
    }

    const activePaths = new Set(paths);
    for (const path of this.files.keys()) {
      if (!activePaths.has(path)) this.files.delete(path);
    }
    for (const path of paths) await this.refreshFile(path);

    return aggregateUsage(this.files.values(), date, current.toISOString());
  }

  private async refreshFile(path: string): Promise<void> {
    let info;
    try {
      info = await stat(path);
    } catch {
      this.files.delete(path);
      return;
    }

    let state = this.files.get(path);
    if (!state || state.inode !== info.ino || info.size < state.offset) {
      state = {
        inode: info.ino,
        offset: 0,
        remainder: Buffer.alloc(0),
        turnModels: new Map(),
        records: new Map(),
      };
      this.files.set(path, state);
    }
    if (info.size === state.offset) return;

    const handle = await open(path, "r");
    try {
      const length = Math.max(0, info.size - state.offset);
      if (length === 0) return;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, state.offset);
      state.offset += bytesRead;
      this.consumeLines(state, Buffer.concat([state.remainder, buffer.subarray(0, bytesRead)]));
    } finally {
      await handle.close();
    }
  }

  private consumeLines(state: FileState, buffer: Buffer): void {
    let start = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      if (buffer[index] !== 10) continue;
      const line = buffer.subarray(start, index);
      start = index + 1;
      if (line.length > 0) parseRelevantLine(line.toString("utf8"), state);
    }
    state.remainder = start < buffer.length ? Buffer.from(buffer.subarray(start)) : Buffer.alloc(0);
  }
}

function parseRelevantLine(line: string, state: FileState): void {
  if (!line.includes('"turn_context"') && !line.includes('"token_usage_record"')) return;
  try {
    const event = JSON.parse(line) as {
      type?: string;
      payload?: {
        turn_id?: unknown;
        response_id?: unknown;
        model?: unknown;
        usage?: Record<string, unknown>;
      };
    };
    const payload = event.payload;
    if (!payload) return;
    if (event.type === "turn_context") {
      if (typeof payload.turn_id === "string" && typeof payload.model === "string" && payload.model.trim()) {
        state.turnModels.set(payload.turn_id, payload.model.trim());
      }
      return;
    }
    if (event.type !== "token_usage_record" || typeof payload.response_id !== "string" || !payload.response_id) return;
    const usage = payload.usage;
    if (!usage || typeof usage !== "object") return;
    state.records.set(payload.response_id, {
      responseId: payload.response_id,
      turnId: typeof payload.turn_id === "string" ? payload.turn_id : null,
      usage: {
        inputTokens: tokenNumber(usage.input_tokens),
        cachedInputTokens: tokenNumber(usage.cached_input_tokens),
        cacheWriteInputTokens: tokenNumber(usage.cache_write_input_tokens),
        outputTokens: tokenNumber(usage.output_tokens),
        reasoningOutputTokens: tokenNumber(usage.reasoning_output_tokens),
        totalTokens: tokenNumber(usage.total_tokens),
      },
    });
  } catch {
    // Ignore malformed or partially-written JSONL records.
  }
}

function aggregateUsage(states: Iterable<FileState>, date: string, updatedAt: string): CodexDailyUsage {
  const turnModels = new Map<string, string>();
  const records = new Map<string, UsageRecord>();
  for (const state of states) {
    for (const [turnId, model] of state.turnModels) turnModels.set(turnId, model);
    for (const [responseId, record] of state.records) {
      if (!records.has(responseId)) records.set(responseId, record);
    }
  }

  const totals = emptyTotals();
  const models = new Map<string, CodexModelUsage>();
  for (const record of records.values()) {
    addUsage(totals, record.usage);
    totals.calls += 1;
    const model = record.turnId ? turnModels.get(record.turnId) ?? "未知模型" : "未知模型";
    const modelUsage = models.get(model) ?? { model, ...emptyTotals() };
    addUsage(modelUsage, record.usage);
    modelUsage.calls += 1;
    models.set(model, modelUsage);
  }

  return {
    date,
    updatedAt,
    ...totals,
    models: [...models.values()].sort((left, right) => right.totalTokens - left.totalTokens || left.model.localeCompare(right.model)),
  };
}

function addUsage(target: CodexUsageTotals, usage: Omit<CodexUsageTotals, "calls">): void {
  target.inputTokens += usage.inputTokens;
  target.cachedInputTokens += usage.cachedInputTokens;
  target.cacheWriteInputTokens += usage.cacheWriteInputTokens;
  target.outputTokens += usage.outputTokens;
  target.reasoningOutputTokens += usage.reasoningOutputTokens;
  target.totalTokens += usage.totalTokens;
}

function emptyTotals(): CodexUsageTotals {
  return {
    calls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function emptyUsage(date: string, updatedAt: string): CodexDailyUsage {
  return { date, updatedAt, ...emptyTotals(), models: [] };
}

function tokenNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function localDateKey(date: Date): string {
  return [
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}
