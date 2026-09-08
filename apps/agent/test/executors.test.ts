import { describe, expect, it } from "vitest";
import { keyCodeFor, MacActionExecutor, type CommandRunner } from "../src/executors.js";

class RecordingRunner implements CommandRunner {
  public readonly calls: Array<{ command: string; args: readonly string[]; input?: string }> = [];
  public constructor(private readonly responder?: (command: string, input?: string) => string) {}
  public async run(command: string, args: readonly string[], input?: string) {
    this.calls.push({ command, args, input });
    return { stdout: this.responder?.(command, input) ?? "50", stderr: "" };
  }
}

const applications = { qq_music: { name: "QQ 音乐", bundleId: "com.tencent.QQMusicMac" } };
const helperPath = "/tmp/touchbar-mac-helper";

function nativeResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    code: "ok",
    message: "ok",
    appInstalled: true,
    accessibilityTrusted: true,
    activated: false,
    eventPosted: false,
    ...overrides,
  });
}

describe("MacActionExecutor", () => {
  it("uses fixed executables and rejects unsafe URL schemes", async () => {
    const runner = new RecordingRunner();
    const executor = new MacActionExecutor({ platform: "darwin", runner, pathExists: async () => false });

    expect(await executor.execute({ type: "openUrl", url: "file:///etc/passwd" })).toMatchObject({ ok: false, outcome: "failed", code: "invalid_value" });
    expect(await executor.execute({ type: "openUrl", url: "https://example.test/path" })).toMatchObject({ ok: true, outcome: "accepted" });
    expect(runner.calls.at(-1)).toMatchObject({ command: "/usr/bin/open", args: ["https://example.test/path"] });

    expect(await executor.execute({ type: "launchApp", bundleId: "com.apple.Safari" })).toMatchObject({ ok: true, outcome: "accepted" });
    expect(runner.calls.at(-1)).toMatchObject({ command: "/usr/bin/open", args: ["-b", "com.apple.Safari"] });
  });

  it("reports missing app and missing Accessibility permission before posting a shortcut", async () => {
    const action = { type: "appShortcut", applicationId: "qq_music", key: "space", modifiers: ["control"] } as const;
    const missingRunner = new RecordingRunner((_command, input) => {
      expect(JSON.parse(input ?? "{}").operation).toBe("check");
      return nativeResponse({ ok: false, appInstalled: false, accessibilityTrusted: false, code: "app_missing" });
    });
    const missingExecutor = new MacActionExecutor({
      platform: "darwin",
      runner: missingRunner,
      applications,
      nativeHelperPath: helperPath,
      pathExists: async (path) => path === helperPath,
    });
    expect(await missingExecutor.getActionAvailability(action)).toMatchObject({ available: false, code: "app_missing" });

    const permissionRunner = new RecordingRunner((_command, input) => {
      expect(JSON.parse(input ?? "{}").operation).toBe("check");
      return nativeResponse({ appInstalled: true, accessibilityTrusted: false });
    });
    const permissionExecutor = new MacActionExecutor({
      platform: "darwin",
      runner: permissionRunner,
      applications,
      nativeHelperPath: helperPath,
      pathExists: async (path) => path === helperPath,
    });
    expect(await permissionExecutor.execute(action)).toMatchObject({ ok: false, outcome: "failed", code: "permission_required" });
    expect(permissionRunner.calls.every((call) => JSON.parse(call.input ?? "{}").operation === "check")).toBe(true);
  });

  it("activates the configured app, posts normalized keys, and returns accepted rather than fake success", async () => {
    const runner = new RecordingRunner((_command, input) => {
      const request = JSON.parse(input ?? "{}") as { operation?: string };
      return request.operation === "check"
        ? nativeResponse()
        : nativeResponse({ activated: true, eventPosted: true });
    });
    const executor = new MacActionExecutor({
      platform: "darwin",
      runner,
      applications,
      nativeHelperPath: helperPath,
      pathExists: async (path) => path === helperPath,
    });

    const result = await executor.execute({
      type: "appShortcut",
      applicationId: "qq_music",
      key: "space",
      modifiers: ["control", "option", "command"],
      activationTimeoutMs: 2000,
      keepForeground: true,
    });

    expect(result).toMatchObject({ ok: true, outcome: "accepted", code: "ok" });
    const shortcutCall = runner.calls.at(-1)!;
    expect(shortcutCall.command).toBe(helperPath);
    expect(JSON.parse(shortcutCall.input ?? "{}")).toEqual({
      operation: "shortcut",
      bundleId: "com.tencent.QQMusicMac",
      keyCode: 49,
      modifiers: ["control", "option", "command"],
      activationTimeoutMs: 2000,
      keepForeground: true,
    });
  });

  it("verifies app launch and treats display sleep as an unverified dispatch", async () => {
    const runner = new RecordingRunner((_command, input) => {
      const request = JSON.parse(input ?? "{}") as { operation?: string };
      return nativeResponse({ activated: request.operation === "launch" });
    });
    const executor = new MacActionExecutor({
      platform: "darwin",
      runner,
      applications,
      nativeHelperPath: helperPath,
      pathExists: async (path) => path === helperPath,
    });

    expect(await executor.execute({ type: "launchApp", applicationId: "qq_music" })).toMatchObject({ ok: true, outcome: "verified" });
    expect(await executor.execute({ type: "system", command: "displaySleep" })).toMatchObject({ ok: true, outcome: "accepted" });
    expect(runner.calls.at(-1)).toMatchObject({ command: "/usr/bin/pmset", args: ["displaysleepnow"] });
  });

  it("maps the supported key vocabulary to macOS virtual key codes", () => {
    expect(keyCodeFor("space")).toBe(49);
    expect(keyCodeFor("left")).toBe(123);
    expect(keyCodeFor("right")).toBe(124);
    expect(keyCodeFor("z")).toBe(6);
    expect(keyCodeFor("unsafe-key")).toBeUndefined();
  });

  it("classifies asynchronous permission failures", async () => {
    const runner: CommandRunner = {
      async run() {
        throw new Error("execution error: “osascript”不允许发送按键。 (1002)");
      },
    };
    const executor = new MacActionExecutor({ platform: "darwin", runner, pathExists: async () => false });

    expect(await executor.execute({ type: "keystroke", key: "space", modifiers: [] })).toMatchObject({
      ok: false,
      outcome: "failed",
      code: "permission_required",
      diagnostic: expect.stringContaining("1002"),
    });
  });
});
