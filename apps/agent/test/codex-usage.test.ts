import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexDailyUsageCollector } from "../src/codex-usage.js";

function turn(turnId: string, model: string): string {
  return JSON.stringify({ type: "turn_context", payload: { turn_id: turnId, model, summary: "ignored" } });
}

function usage(responseId: string, turnId: string, totalTokens: number, overrides: Record<string, number> = {}): string {
  return JSON.stringify({
    type: "token_usage_record",
    payload: {
      turn_id: turnId,
      response_id: responseId,
      usage: {
        input_tokens: 100,
        cached_input_tokens: 20,
        cache_write_input_tokens: 5,
        output_tokens: 30,
        reasoning_output_tokens: 10,
        total_tokens: totalTokens,
        ...overrides,
      },
      turn_token_usage: { total_tokens: 999_999 },
      thread_token_usage: { total_tokens: 9_999_999 },
    },
  });
}

async function fixture() {
  const codexHome = await mkdtemp(join(tmpdir(), "touchbar-codex-daily-"));
  const now = new Date(2026, 8, 7, 10, 0, 0);
  const day = join(codexHome, "sessions", "2026", "09", "07");
  await mkdir(day, { recursive: true });
  return { codexHome, now, day };
}

describe("CodexDailyUsageCollector", () => {
  it("aggregates all daily files by model and deduplicates response ids", async () => {
    const { codexHome, now, day } = await fixture();
    await writeFile(join(day, "one.jsonl"), [
      JSON.stringify({ type: "response_item", payload: { content: "private text must not be inspected" } }),
      turn("turn-a", "gpt-sol"),
      usage("response-a", "turn-a", 145),
      usage("shared-response", "turn-a", 200),
      "",
    ].join("\n"));
    await writeFile(join(day, "two.jsonl"), [
      turn("turn-b", "gpt-terra"),
      usage("response-b", "turn-b", 300, { input_tokens: 240 }),
      usage("shared-response", "turn-a", 200),
      "{malformed",
      "",
    ].join("\n"));

    const collector = new CodexDailyUsageCollector({ codexHome, now: () => now });
    const result = await collector.snapshot();

    expect(result).toMatchObject({ date: "2026-09-07", calls: 3, totalTokens: 645, inputTokens: 440 });
    expect(result.models).toEqual([
      expect.objectContaining({ model: "gpt-sol", calls: 2, totalTokens: 345 }),
      expect.objectContaining({ model: "gpt-terra", calls: 1, totalTokens: 300 }),
    ]);
  });

  it("reads only appended bytes and safely rebuilds a truncated file", async () => {
    const { codexHome, now, day } = await fixture();
    const path = join(day, "rollout.jsonl");
    await writeFile(path, `${turn("turn-a", "gpt-sol")}\n${usage("response-a", "turn-a", 145)}\n`);
    const collector = new CodexDailyUsageCollector({ codexHome, now: () => now });

    expect(await collector.snapshot()).toMatchObject({ calls: 1, totalTokens: 145 });
    await appendFile(path, `${usage("response-b", "turn-a", 155)}\n`);
    expect(await collector.snapshot()).toMatchObject({ calls: 2, totalTokens: 300 });

    await writeFile(path, `${turn("turn-c", "gpt-luna")}\n${usage("response-c", "turn-c", 77)}\n`);
    const rebuilt = await collector.snapshot();
    expect(rebuilt).toMatchObject({ calls: 1, totalTokens: 77 });
    expect(rebuilt.models).toEqual([expect.objectContaining({ model: "gpt-luna", calls: 1 })]);
  });

  it("resets at local midnight and returns zero usage when no files exist", async () => {
    const { codexHome, now, day } = await fixture();
    await writeFile(join(day, "rollout.jsonl"), `${turn("turn-a", "gpt-sol")}\n${usage("response-a", "turn-a", 145)}\n`);
    let current = now;
    const collector = new CodexDailyUsageCollector({ codexHome, now: () => current });
    expect(await collector.snapshot()).toMatchObject({ date: "2026-09-07", calls: 1 });

    current = new Date(2026, 8, 8, 0, 1, 0);
    expect(await collector.snapshot()).toMatchObject({ date: "2026-09-08", calls: 0, totalTokens: 0, models: [] });
  });
});
