import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfigPath, loadConfig } from "../src/config.js";

const exampleConfigPath = resolve(import.meta.dirname, "../../../config/touchbar.example.json");

describe("default configuration", () => {
  it("loads the bundled JSON through the shared protocol validator with compact-layout hints", async () => {
    const config = await loadConfig(defaultConfigPath);
    expect(config).toMatchObject({ version: 2, server: { port: 8787 } });
    expect(config.tabs.map((tab) => tab.role)).toEqual(["monitor", "control", "shortcuts"]);
    expect(config.applications.qq_music).toMatchObject({ bundleId: "com.tencent.QQMusicMac" });

    const monitorGroups = config.tabs[0]!.groups;
    expect(monitorGroups.map((group) => group.id)).toEqual(["system_resources", "device_agent", "codex_today"]);
    expect(monitorGroups[0]).toMatchObject({ columns: 4, presentation: "tiles", span: "full" });
    expect(monitorGroups[1]).toMatchObject({ presentation: "details", span: "full" });
    expect(monitorGroups[2]).toMatchObject({
      id: "codex_today",
      title: "今日 AI 消费",
      presentation: "details",
      span: "full",
    });
    expect(monitorGroups[1]!.items.map((item) => item.id)).not.toContain("device_time");
    expect(monitorGroups[2]!.items).toEqual([
      expect.objectContaining({ id: "tokens_today", label: "今日 AI 消费" }),
    ]);

    const systemControls = config.tabs[1]!.groups.find((group) => group.id === "system_controls")!;
    expect(systemControls.columns).toBe(2);
    expect(systemControls.items.map((item) => item.actionId)).toEqual([
      "volume_set",
      "volume_toggle_mute",
      "system_display_sleep",
    ]);

    const favoriteApps = config.tabs[2]!.groups.find((group) => group.id === "favorite_apps")!;
    expect(favoriteApps.columns).toBe(1);
    expect(favoriteApps.items).toEqual([
      expect.objectContaining({ id: "app_qq_music", actionId: "qqmusic_launch" }),
    ]);
    expect(config.actions.qqmusic_launch).toMatchObject({ type: "launchApp", applicationId: "qq_music" });
  });

  it("keeps the distributable example equal to the validated default configuration", async () => {
    const [defaultJson, exampleJson, exampleConfig] = await Promise.all([
      readFile(defaultConfigPath, "utf8"),
      readFile(exampleConfigPath, "utf8"),
      loadConfig(exampleConfigPath),
    ]);

    expect(exampleJson).toBe(defaultJson);
    expect(exampleConfig).toEqual(await loadConfig(defaultConfigPath));
  });
});
