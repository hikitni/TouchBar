import { describe, expect, it } from "vitest";
import { touchBarConfigSchema } from "./index.js";

const validConfig: any = {
  version: 2,
  server: { port: 8787, pairingTtlSeconds: 600 },
  applications: {
    music: { name: "QQ 音乐", bundleId: "com.tencent.QQMusicMac", icon: "🎵" },
  },
  tabs: [
    { id: "monitor", role: "monitor", title: "系统监控", groups: [{ id: "metrics", title: "指标", items: [{ id: "cpu", type: "status", statusKey: "cpu" }] }] },
    { id: "control", role: "control", title: "控制", groups: [{ id: "music_controls", title: "音乐", kind: "app", applicationId: "music", items: [{ id: "play", type: "button", actionId: "play" }] }] },
    { id: "shortcuts", role: "shortcuts", title: "快捷方式", groups: [] },
  ],
  actions: {
    play: { type: "appShortcut", applicationId: "music", key: "space", modifiers: ["control"] },
  },
};

const legacyConfig = {
  version: 1,
  server: { port: 8787, pairingTtlSeconds: 600 },
  profiles: [{
    id: "main",
    title: "Main",
    columns: 4,
    items: [{ id: "play", type: "button", actionId: "play" }],
  }],
  actions: { play: { type: "media", command: "playPause" } },
};

describe("touchBarConfigSchema", () => {
  it("accepts a v2 grouped dashboard config", () => {
    const parsed = touchBarConfigSchema.parse(validConfig);
    expect(parsed.version).toBe(2);
    expect(parsed.tabs.map((tab) => tab.role)).toEqual(["monitor", "control", "shortcuts"]);
    expect(parsed.actions.play).toMatchObject({ type: "appShortcut", activationTimeoutMs: 2000, keepForeground: true });
  });

  it("accepts optional presentation hints without changing legacy defaults", () => {
    const original = touchBarConfigSchema.parse(validConfig);
    expect(original.tabs[0]?.groups[0]?.presentation).toBeUndefined();
    expect(original.tabs[0]?.groups[0]?.span).toBeUndefined();
    const hinted = structuredClone(validConfig);
    hinted.tabs[0].groups[0].presentation = "details";
    hinted.tabs[0].groups[0].span = "full";
    expect(touchBarConfigSchema.parse(hinted).tabs[0]?.groups[0]).toMatchObject({ presentation: "details", span: "full" });
    hinted.tabs[0].groups[0].presentation = "arbitrary";
    expect(touchBarConfigSchema.safeParse(hinted).success).toBe(false);
    hinted.tabs[0].groups[0].presentation = "tiles";
    hinted.tabs[0].groups[0].span = "invalid";
    expect(touchBarConfigSchema.safeParse(hinted).success).toBe(false);
  });

  it("migrates a v1 profile config into the fixed v2 tabs", () => {
    const parsed = touchBarConfigSchema.parse(legacyConfig);
    expect(parsed.version).toBe(2);
    expect(parsed.tabs[1]?.groups[0]).toMatchObject({ id: "legacy_main", title: "Main" });
    expect(parsed.tabs[2]?.groups).toEqual([]);
  });

  it("rejects an unknown action id", () => {
    const invalid = structuredClone(validConfig);
    invalid.tabs[1]!.groups[0]!.items[0]!.actionId = "missing";
    expect(() => touchBarConfigSchema.parse(invalid)).toThrow(/Unknown action id/);
  });

  it("rejects duplicate group and item ids", () => {
    const duplicateGroup = structuredClone(validConfig);
    duplicateGroup.tabs[2]!.groups.push(structuredClone(duplicateGroup.tabs[0]!.groups[0]!));
    expect(() => touchBarConfigSchema.parse(duplicateGroup)).toThrow(/Duplicate group id/);

    const duplicateItem = structuredClone(validConfig);
    duplicateItem.tabs[2]!.groups.push({ id: "links", title: "Links", items: [{ id: "cpu", type: "status", statusKey: "cpu" }] } as never);
    expect(() => touchBarConfigSchema.parse(duplicateItem)).toThrow(/Duplicate item id/);
  });

  it("rejects invalid tab order and application references", () => {
    const wrongOrder = structuredClone(validConfig);
    wrongOrder.tabs[0]!.role = "control" as never;
    expect(() => touchBarConfigSchema.parse(wrongOrder)).toThrow(/Tab order/);

    const missingApp = structuredClone(validConfig);
    missingApp.actions.play.applicationId = "missing";
    expect(() => touchBarConfigSchema.parse(missingApp)).toThrow(/Unknown application id/);
  });

  it("rejects invalid slider bounds", () => {
    const invalid = structuredClone(validConfig);
    invalid.actions.play = { type: "volume", command: "set" } as never;
    invalid.tabs[1]!.groups[0]!.items[0] = {
      id: "volume",
      type: "slider",
      actionId: "play",
      statusKey: "volume",
      min: 100,
      max: 0,
      step: 1,
    } as never;
    expect(() => touchBarConfigSchema.parse(invalid)).toThrow(/Invalid slider range/);
  });
});
