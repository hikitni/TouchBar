import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  ActionAvailability,
  ActionResultCode,
  ApplicationDefinition,
  CapabilityMap,
  TouchBarAction,
} from "@touchbar/protocol";

export type ExecutionCode = Exclude<ActionResultCode, "unauthorized" | "not_found">;
export interface ExecutionResult {
  ok: boolean;
  outcome: "verified" | "accepted" | "failed";
  code: ExecutionCode;
  message: string;
  /** Internal diagnostic for local Agent logs; never returned by the HTTP API. */
  diagnostic?: string;
}

export interface AudioStatus {
  volume: number | null;
  muted: boolean | null;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], input?: string): Promise<CommandResult>;
}

export interface AgentExecutor {
  getCapabilities(): Promise<CapabilityMap>;
  getActionAvailability?(action: TouchBarAction): Promise<ActionAvailability>;
  execute(action: TouchBarAction, value?: number): Promise<ExecutionResult>;
  getAudioStatus(): Promise<AudioStatus>;
}

export interface MacExecutorOptions {
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
  pathExists?: (path: string) => Promise<boolean>;
  applications?: Record<string, ApplicationDefinition>;
  nativeHelperPath?: string;
}

interface NativeHelperResponse {
  ok: boolean;
  code: string;
  message: string;
  appInstalled: boolean;
  accessibilityTrusted: boolean;
  activated: boolean;
  eventPosted: boolean;
}

const APPLE_SCRIPT = "/usr/bin/osascript";
const OPEN = "/usr/bin/open";
const PMSET = "/usr/bin/pmset";
const SCREEN_CAPTURE = "/usr/sbin/screencapture";
const LOCK_SESSION = "/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession";
const BTT_APP_PATHS = ["/Applications/BetterTouchTool.app", "/Applications/BetterTouchTool.app/Contents/MacOS/BetterTouchTool"];
const QQ_MUSIC_APP_PATHS = ["/Applications/QQMusic.app", `${process.env.HOME ?? ""}/Applications/QQMusic.app`];
const QQ_MUSIC_BUNDLE_ID = "com.tencent.QQMusicMac";
const DEFAULT_NATIVE_HELPER = fileURLToPath(new URL("../native/.build/touchbar-mac-helper", import.meta.url));

/**
 * Executes only fixed macOS utilities with independently validated arguments. No route can
 * provide a command path, a shell string, an AppleScript program, or an app filesystem path.
 */
export class MacActionExecutor implements AgentExecutor {
  private readonly platform: NodeJS.Platform;
  private readonly runner: CommandRunner;
  private readonly pathExists: (path: string) => Promise<boolean>;
  private readonly applications: Record<string, ApplicationDefinition>;
  private readonly nativeHelperPath: string;
  private capabilities: CapabilityMap | undefined;
  private readonly nativeCheckCache = new Map<string, { at: number; promise: Promise<NativeHelperResponse> }>();
  private volumeQueue: Promise<ExecutionResult> = Promise.resolve(verified("ready"));

  public constructor(options: MacExecutorOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.runner = options.runner ?? new SpawnCommandRunner();
    this.pathExists = options.pathExists ?? exists;
    this.applications = options.applications ?? {};
    this.nativeHelperPath = options.nativeHelperPath ?? process.env.TOUCHBAR_MAC_HELPER ?? DEFAULT_NATIVE_HELPER;
  }

  public async getCapabilities(): Promise<CapabilityMap> {
    if (this.capabilities) return this.capabilities;
    const supported = this.platform === "darwin";
    const [hasBtt, hasNativeHelper] = supported
      ? await Promise.all([
          Promise.all(BTT_APP_PATHS.map(this.pathExists)).then((results) => results.some(Boolean)),
          this.pathExists(this.nativeHelperPath),
        ])
      : [false, false];
    this.capabilities = {
      media: supported,
      volume: supported,
      brightness: supported,
      system: supported,
      launchApp: supported,
      openUrl: supported,
      keystroke: supported,
      appShortcut: supported && hasNativeHelper,
      bttTrigger: hasBtt,
    };
    return this.capabilities;
  }

  public async getActionAvailability(action: TouchBarAction): Promise<ActionAvailability> {
    const capabilities = await this.getCapabilities();
    if (!capabilities[capabilityFor(action)]) {
      return unavailable(
        action.type === "appShortcut" ? "misconfigured" : "unsupported",
        action.type === "appShortcut" ? "macOS 原生快捷键助手尚未构建" : unsupportedMessage(action),
      );
    }

    if (action.type !== "appShortcut" && action.type !== "launchApp") return available();
    const bundleId = this.bundleIdFor(action);
    if (!bundleId) return unavailable("misconfigured", "操作引用的应用配置不存在");

    if (!(await this.pathExists(this.nativeHelperPath))) {
      return action.type === "appShortcut"
        ? unavailable("misconfigured", "macOS 原生快捷键助手尚未构建")
        : available();
    }

    try {
      const checked = await this.checkNativeApp(bundleId);
      if (!checked.appInstalled) return unavailable("app_missing", "未安装目标应用");
      if (action.type === "appShortcut" && !checked.accessibilityTrusted) {
        return unavailable("permission_required", "请在“隐私与安全性 → 辅助功能”中允许 Touch Bar Agent");
      }
      return available();
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      return unavailable("misconfigured", `无法检查原生控制能力：${diagnostic}`);
    }
  }

  public async execute(action: TouchBarAction, value?: number): Promise<ExecutionResult> {
    const availability = await this.getActionAvailability(action);
    if (!availability.available) return failure(availabilityCode(availability.code), availability.message ?? "当前操作不可用");

    try {
      switch (action.type) {
        case "media":
          return await this.executeMedia(action.command, action.player);
        case "volume":
          return await this.enqueueVolume(() => this.executeVolume(action.command, value));
        case "brightness":
          return await this.runAppleScript(`tell application "System Events" to key code ${action.command === "up" ? 145 : 144}`, "亮度调整指令已发送");
        case "system":
          return await this.executeSystem(action.command);
        case "launchApp":
          return await this.executeLaunchApp(action);
        case "openUrl":
          return await this.executeOpenUrl(action.url);
        case "keystroke":
          return await this.executeKeystroke(action.key, action.modifiers);
        case "appShortcut":
          return await this.executeAppShortcut(action);
        case "bttTrigger":
          return await this.executeBttTrigger(action.triggerName);
      }
    } catch (error) {
      return fromExecutionError(error);
    }
  }

  public async getAudioStatus(): Promise<AudioStatus> {
    const capabilities = await this.getCapabilities();
    if (!capabilities.volume) return { volume: null, muted: null };
    try {
      const [volumeResult, mutedResult] = await Promise.all([
        this.runner.run(APPLE_SCRIPT, ["-e", "output volume of (get volume settings)"]),
        this.runner.run(APPLE_SCRIPT, ["-e", "output muted of (get volume settings)"]),
      ]);
      const volume = Number.parseInt(volumeResult.stdout.trim(), 10);
      const muted = mutedResult.stdout.trim().toLowerCase() === "true";
      return { volume: Number.isFinite(volume) ? volume : null, muted };
    } catch {
      return { volume: null, muted: null };
    }
  }

  private async executeMedia(
    command: "previous" | "playPause" | "next",
    player: "qqMusic" | "system" | "music",
  ): Promise<ExecutionResult> {
    if (player === "music") {
      const source = {
        previous: 'tell application "Music" to previous track',
        playPause: 'tell application "Music" to playpause',
        next: 'tell application "Music" to next track',
      }[command];
      return this.runAppleScript(source, "音乐控制指令已发送");
    }

    if (player === "qqMusic") {
      const installed = (await Promise.all(QQ_MUSIC_APP_PATHS.map(this.pathExists))).some(Boolean);
      if (!installed) return failure("app_missing", "未安装 QQ 音乐");
      await this.runner.run(OPEN, ["-g", "-b", QQ_MUSIC_BUNDLE_ID]);
    }

    await this.runner.run(APPLE_SCRIPT, ["-l", "JavaScript", "-e", mediaKeyScript(command)]);
    return accepted(player === "qqMusic" ? "QQ 音乐控制指令已发送，未能验证最终状态" : "媒体控制指令已发送");
  }

  private async executeVolume(command: "mute" | "toggleMute" | "set", value?: number): Promise<ExecutionResult> {
    const before = command === "toggleMute" ? await this.getAudioStatus() : null;
    if (command === "mute") {
      await this.runner.run(APPLE_SCRIPT, ["-e", "set volume with output muted"]);
      const after = await this.getAudioStatus();
      return after.muted === true ? verified("已静音") : accepted("静音指令已发送，未能验证最终状态");
    }
    if (command === "toggleMute") {
      await this.runner.run(APPLE_SCRIPT, ["-e", "set volume with output muted (not (output muted of (get volume settings)))"]);
      const after = await this.getAudioStatus();
      return before?.muted !== null && after.muted !== null && before?.muted !== after.muted
        ? verified("静音状态已切换")
        : accepted("静音切换指令已发送，未能验证最终状态");
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
      return failure("invalid_value", "音量必须在 0 到 100 之间");
    }
    const target = Math.round(value);
    await this.runner.run(APPLE_SCRIPT, ["-e", `set volume output volume ${target}`]);
    const after = await this.getAudioStatus();
    return after.volume !== null && Math.abs(after.volume - target) <= 1
      ? verified("音量已调整")
      : accepted("音量调整指令已发送，未能验证最终状态");
  }

  private async executeSystem(command: "lock" | "displaySleep" | "screenshot"): Promise<ExecutionResult> {
    switch (command) {
      case "lock":
        if (await this.pathExists(LOCK_SESSION)) {
          await this.runner.run(LOCK_SESSION, ["-suspend"]);
          return accepted("锁屏指令已发送");
        }
        return this.runAppleScript(
          'tell application "System Events" to keystroke "q" using {control down, command down}',
          "锁屏指令已发送",
        );
      case "displaySleep":
        await this.runner.run(PMSET, ["displaysleepnow"]);
        return accepted("立即息屏指令已发送");
      case "screenshot":
        await this.runner.run(SCREEN_CAPTURE, ["-x"]);
        return accepted("截图指令已发送");
    }
  }

  private async executeLaunchApp(action: Extract<TouchBarAction, { type: "launchApp" }>): Promise<ExecutionResult> {
    const bundleId = this.bundleIdFor(action);
    if (!bundleId) return failure("misconfigured", "操作引用的应用配置不存在");
    if (await this.pathExists(this.nativeHelperPath)) {
      const response = await this.runNativeHelper({ operation: "launch", bundleId, activationTimeoutMs: 2_000 });
      return nativeFailure(response) ?? verified("应用已启动并进入前台");
    }
    await this.runner.run(OPEN, ["-b", bundleId]);
    return accepted("应用启动指令已发送");
  }

  private async executeOpenUrl(rawUrl: string): Promise<ExecutionResult> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return failure("invalid_value", "配置的网址无效");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return failure("invalid_value", "仅允许打开 HTTP(S) 网址");
    }
    await this.runner.run(OPEN, [url.toString()]);
    return accepted("网址打开指令已发送");
  }

  private async executeKeystroke(key: string, modifiers: readonly string[]): Promise<ExecutionResult> {
    const keyCode = keyCodeFor(key);
    if (keyCode === undefined) return failure("invalid_value", `不支持配置的按键：${key}`);
    const modifierTokens = modifiers.map(modifierToAppleScript).filter((value): value is string => value !== undefined);
    if (modifierTokens.length !== modifiers.length) return failure("invalid_value", "不支持配置的组合键修饰符");
    const using = modifierTokens.length > 0 ? ` using {${modifierTokens.join(", ")}}` : "";
    return this.runAppleScript(`tell application "System Events" to key code ${keyCode}${using}`, "快捷键已发送");
  }

  private async executeAppShortcut(action: Extract<TouchBarAction, { type: "appShortcut" }>): Promise<ExecutionResult> {
    const bundleId = this.bundleIdFor(action);
    const keyCode = keyCodeFor(action.key);
    if (!bundleId || keyCode === undefined) return failure("misconfigured", "应用或快捷键配置无效");
    const response = await this.runNativeHelper({
      operation: "shortcut",
      bundleId,
      keyCode,
      modifiers: action.modifiers,
      activationTimeoutMs: action.activationTimeoutMs,
      keepForeground: action.keepForeground,
    });
    const failed = nativeFailure(response);
    if (failed) return failed;
    if (!response.activated || !response.eventPosted) return failure("execution_failed", "快捷键未能发送到目标应用");
    return accepted("快捷键已发送，未能验证目标应用最终状态");
  }

  private async executeBttTrigger(triggerName: string): Promise<ExecutionResult> {
    if (triggerName.length === 0 || triggerName.length > 200) return failure("invalid_value", "配置的 BTT Trigger 无效");
    const url = `btt://trigger_named/?trigger_name=${encodeURIComponent(triggerName)}`;
    await this.runner.run(OPEN, [url]);
    return accepted("BetterTouchTool 指令已发送");
  }

  private async runAppleScript(source: string, message: string): Promise<ExecutionResult> {
    await this.runner.run(APPLE_SCRIPT, ["-e", source]);
    return accepted(message);
  }

  private checkNativeApp(bundleId: string): Promise<NativeHelperResponse> {
    const cached = this.nativeCheckCache.get(bundleId);
    if (cached && Date.now() - cached.at < 5_000) return cached.promise;
    const promise = this.runNativeHelper({ operation: "check", bundleId }).catch((error) => {
      this.nativeCheckCache.delete(bundleId);
      throw error;
    });
    this.nativeCheckCache.set(bundleId, { at: Date.now(), promise });
    return promise;
  }

  private async runNativeHelper(payload: Record<string, unknown>): Promise<NativeHelperResponse> {
    const result = await this.runner.run(this.nativeHelperPath, [], `${JSON.stringify(payload)}\n`);
    const parsed = JSON.parse(result.stdout.trim()) as Partial<NativeHelperResponse>;
    if (typeof parsed.ok !== "boolean" || typeof parsed.code !== "string" || typeof parsed.message !== "string") {
      throw new Error("Native helper returned an invalid response");
    }
    return {
      ok: parsed.ok,
      code: parsed.code,
      message: parsed.message,
      appInstalled: parsed.appInstalled === true,
      accessibilityTrusted: parsed.accessibilityTrusted === true,
      activated: parsed.activated === true,
      eventPosted: parsed.eventPosted === true,
    };
  }

  private bundleIdFor(action: Extract<TouchBarAction, { type: "launchApp" | "appShortcut" }>): string | undefined {
    if (action.type === "launchApp" && action.bundleId) return action.bundleId;
    const applicationId = action.applicationId;
    return applicationId ? this.applications[applicationId]?.bundleId : undefined;
  }

  private async enqueueVolume(operation: () => Promise<ExecutionResult>): Promise<ExecutionResult> {
    const next = this.volumeQueue.then(operation, operation);
    this.volumeQueue = next.catch(() => verified("volume queue recovered"));
    return next;
  }
}

export class SpawnCommandRunner implements CommandRunner {
  public run(command: string, args: readonly string[], input?: string): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], { shell: false, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => child.kill("SIGTERM"), 10_000);
      child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`Command failed (code ${code ?? "none"}, signal ${signal ?? "none"}): ${stderr.trim()}`));
      });
      if (input !== undefined && child.stdin) child.stdin.end(input);
    });
  }
}

function capabilityFor(action: TouchBarAction): keyof CapabilityMap {
  return action.type === "bttTrigger" ? "bttTrigger" : action.type;
}

function modifierToAppleScript(modifier: string): string | undefined {
  return {
    command: "command down",
    option: "option down",
    control: "control down",
    shift: "shift down",
    fn: "fn down",
  }[modifier];
}

export function keyCodeFor(rawKey: string): number | undefined {
  const key = rawKey.toLowerCase();
  const named: Record<string, number> = {
    space: 49, return: 36, enter: 76, tab: 48, escape: 53, delete: 51,
    left: 123, right: 124, down: 125, up: 126,
    home: 115, end: 119, pageup: 116, pagedown: 121,
  };
  if (key in named) return named[key];
  const characters: Record<string, number> = {
    a: 0, b: 11, c: 8, d: 2, e: 14, f: 3, g: 5, h: 4, i: 34, j: 38, k: 40, l: 37,
    m: 46, n: 45, o: 31, p: 35, q: 12, r: 15, s: 1, t: 17, u: 32, v: 9, w: 13, x: 7, y: 16, z: 6,
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
  };
  return characters[key];
}

function mediaKeyScript(command: "previous" | "playPause" | "next"): string {
  const keyCode = { previous: 18, playPause: 16, next: 17 }[command];
  return `
ObjC.import("Cocoa");
ObjC.import("ApplicationServices");
function postMediaKey(state) {
  const event = $.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2(
    14, $.NSMakePoint(0, 0), 0, 0, 0, null, 8, (${keyCode} << 16) | (state << 8), -1
  );
  $.CGEventPost(0, event.CGEvent);
}
postMediaKey(0xA);
postMediaKey(0xB);`;
}

function verified(message: string): ExecutionResult {
  return { ok: true, outcome: "verified", code: "ok", message };
}

function accepted(message: string): ExecutionResult {
  return { ok: true, outcome: "accepted", code: "ok", message };
}

function failure(code: Exclude<ExecutionCode, "ok">, message: string): ExecutionResult {
  return { ok: false, outcome: "failed", code, message };
}

function nativeFailure(response: NativeHelperResponse): ExecutionResult | null {
  if (response.ok) return null;
  const code: Exclude<ExecutionCode, "ok"> = response.code === "permission_required"
    ? "permission_required"
    : response.code === "app_missing"
      ? "app_missing"
      : response.code === "activation_failed"
        ? "activation_failed"
        : response.code === "misconfigured"
          ? "misconfigured"
          : "execution_failed";
  return failure(code, response.message);
}

function fromExecutionError(error: unknown): ExecutionResult {
  const diagnostic = error instanceof Error ? error.message : String(error);
  if (/not authorized|-1743|1002|not allowed to send keystrokes|accessibility|automation|screen recording|不允许发送按键|不允许辅助访问/i.test(diagnostic)) {
    return {
      ...failure("permission_required", "需要授予 macOS 辅助功能权限才能执行此操作"),
      diagnostic,
    };
  }
  if (/ENOENT|no such file or directory/i.test(diagnostic)) {
    return {
      ...failure("unsupported", "当前 macOS 不支持此系统指令"),
      diagnostic,
    };
  }
  return { ...failure("execution_failed", "macOS 未能完成此操作"), diagnostic };
}

function availabilityCode(code: ActionAvailability["code"]): Exclude<ExecutionCode, "ok"> {
  if (code === "permission_required" || code === "app_missing" || code === "misconfigured" || code === "unsupported") return code;
  return "execution_failed";
}

function available(): ActionAvailability {
  return { available: true, code: "available" };
}

function unavailable(code: Exclude<ActionAvailability["code"], "available">, message: string): ActionAvailability {
  return { available: false, code, message };
}

function unsupportedMessage(action: TouchBarAction): string {
  return action.type === "bttTrigger" ? "未检测到 BetterTouchTool" : "当前 Mac 不支持此操作";
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
