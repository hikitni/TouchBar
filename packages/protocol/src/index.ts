import { z } from "zod";

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const bundleIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{1,199}$/);
const modifierSchema = z.enum(["command", "option", "control", "shift", "fn"]);

export const shortcutKeySchema = z.enum([
  "space", "return", "enter", "tab", "escape", "delete",
  "left", "right", "down", "up", "home", "end", "pageup", "pagedown",
  "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
  "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
]);

export const applicationDefinitionSchema = z.object({
  name: z.string().min(1).max(80),
  bundleId: bundleIdentifier,
  icon: z.string().max(32).optional(),
});

export const mediaActionSchema = z.object({
  type: z.literal("media"),
  command: z.enum(["previous", "playPause", "next"]),
  player: z.enum(["qqMusic", "system", "music"]).default("qqMusic"),
});

export const volumeActionSchema = z.object({
  type: z.literal("volume"),
  command: z.enum(["mute", "toggleMute", "set"]),
});

export const brightnessActionSchema = z.object({
  type: z.literal("brightness"),
  command: z.enum(["down", "up"]),
});

export const systemActionSchema = z.object({
  type: z.literal("system"),
  command: z.enum(["lock", "displaySleep", "screenshot"]),
});

export const launchAppActionSchema = z.object({
  type: z.literal("launchApp"),
  applicationId: identifier.optional(),
  bundleId: bundleIdentifier.optional(),
});

export const openUrlActionSchema = z.object({
  type: z.literal("openUrl"),
  url: z.string().url(),
});

export const keystrokeActionSchema = z.object({
  type: z.literal("keystroke"),
  key: shortcutKeySchema,
  modifiers: z.array(modifierSchema).max(5).default([]),
});

export const appShortcutActionSchema = z.object({
  type: z.literal("appShortcut"),
  applicationId: identifier,
  key: shortcutKeySchema,
  modifiers: z.array(modifierSchema).max(5).default([]),
  activationTimeoutMs: z.number().int().min(250).max(10_000).default(2_000),
  keepForeground: z.boolean().default(true),
});

export const bttTriggerActionSchema = z.object({
  type: z.literal("bttTrigger"),
  triggerName: z.string().min(1).max(200),
});

export const actionSchema = z.discriminatedUnion("type", [
  mediaActionSchema,
  volumeActionSchema,
  brightnessActionSchema,
  systemActionSchema,
  launchAppActionSchema,
  openUrlActionSchema,
  keystrokeActionSchema,
  appShortcutActionSchema,
  bttTriggerActionSchema,
]);

const itemBaseSchema = z.object({
  id: identifier,
  label: z.string().max(80).optional(),
  icon: z.string().max(32).optional(),
  className: z.string().max(80).optional(),
});

export const buttonItemSchema = itemBaseSchema.extend({
  type: z.literal("button"),
  actionId: identifier,
  confirm: z.boolean().optional(),
});

export const sliderItemSchema = itemBaseSchema.extend({
  type: z.literal("slider"),
  actionId: identifier,
  statusKey: z.literal("volume"),
  min: z.number().default(0),
  max: z.number().default(100),
  step: z.number().positive().default(1),
});

export const statusItemSchema = itemBaseSchema.extend({
  type: z.literal("status"),
  statusKey: z.enum([
    "connection",
    "volume",
    "time",
    "lastAction",
    "cpu",
    "memory",
    "disk",
    "battery",
    "uptime",
    "network",
    "systemInfo",
    "codexTokens",
    "tokenQuota",
    "actions",
  ]),
});

export const tokenUsageItemSchema = itemBaseSchema.extend({
  type: z.literal("tokenUsage"),
});

export const spacerItemSchema = z.object({
  id: identifier,
  type: z.literal("spacer"),
});

export const profileItemSchema = z.discriminatedUnion("type", [
  buttonItemSchema,
  sliderItemSchema,
  statusItemSchema,
  spacerItemSchema,
]);

export const dashboardItemSchema = z.discriminatedUnion("type", [
  buttonItemSchema,
  sliderItemSchema,
  statusItemSchema,
  tokenUsageItemSchema,
  spacerItemSchema,
]);

export const profileSchema = z.object({
  id: identifier,
  title: z.string().min(1).max(80),
  icon: z.string().max(32).optional(),
  columns: z.number().int().min(2).max(12).default(6),
  items: z.array(profileItemSchema).min(1),
});

export const dashboardGroupSchema = z.object({
  id: identifier,
  title: z.string().min(1).max(80),
  icon: z.string().max(32).optional(),
  description: z.string().max(240).optional(),
  kind: z.enum(["section", "app", "metrics"]).default("section"),
  applicationId: identifier.optional(),
  presentation: z.enum(["tiles", "details"]).optional(),
  span: z.enum(["auto", "full"]).optional(),
  columns: z.number().int().min(1).max(6).default(4),
  items: z.array(dashboardItemSchema).min(1),
});

export const dashboardTabSchema = z.object({
  id: identifier,
  role: z.enum(["monitor", "control", "shortcuts"]),
  title: z.string().min(1).max(80),
  icon: z.string().max(32).optional(),
  groups: z.array(dashboardGroupSchema),
});

const serverSchema = z.object({
  port: z.number().int().min(1024).max(65535).default(8787),
  pairingTtlSeconds: z.number().int().min(60).max(3600).default(600),
}).default({ port: 8787, pairingTtlSeconds: 600 });

const legacyTouchBarConfigSchema = z.object({
  version: z.literal(1),
  server: serverSchema,
  profiles: z.array(profileSchema).min(1),
  actions: z.record(identifier, actionSchema),
}).superRefine((config, context) => {
  validateLegacyConfig(config, context);
});

export const touchBarConfigV2Schema = z.object({
  version: z.literal(2),
  server: serverSchema,
  applications: z.record(identifier, applicationDefinitionSchema).default({}),
  tabs: z.array(dashboardTabSchema).length(3),
  actions: z.record(identifier, actionSchema),
}).superRefine((config, context) => {
  validateV2Config(config, context);
});

export const touchBarConfigSchema = z.union([touchBarConfigV2Schema, legacyTouchBarConfigSchema])
  .transform((config) => config.version === 2 ? config : migrateLegacyConfig(config));

export type TouchBarConfig = z.infer<typeof touchBarConfigV2Schema>;
export type TouchBarAction = z.infer<typeof actionSchema>;
export type ApplicationDefinition = z.infer<typeof applicationDefinitionSchema>;
export type DashboardTab = z.infer<typeof dashboardTabSchema>;
export type DashboardGroup = z.infer<typeof dashboardGroupSchema>;
export type DashboardItem = z.infer<typeof dashboardItemSchema>;
export type Profile = z.infer<typeof profileSchema>;
export type ProfileItem = z.infer<typeof profileItemSchema>;

function validateLegacyConfig(config: z.infer<typeof legacyTouchBarConfigSchema>, context: z.RefinementCtx): void {
  const profileIds = new Set<string>();
  const itemIds = new Set<string>();
  for (const profile of config.profiles) {
    if (profileIds.has(profile.id)) {
      context.addIssue({ code: "custom", path: ["profiles"], message: `Duplicate profile id: ${profile.id}` });
    }
    profileIds.add(profile.id);
    for (const item of profile.items) {
      const qualifiedId = `${profile.id}/${item.id}`;
      if (itemIds.has(qualifiedId)) {
        context.addIssue({ code: "custom", path: ["profiles"], message: `Duplicate item id: ${qualifiedId}` });
      }
      itemIds.add(qualifiedId);
      validateItem(item, qualifiedId, config.actions, context, ["profiles"]);
    }
  }
}

function validateV2Config(config: z.infer<typeof touchBarConfigV2Schema>, context: z.RefinementCtx): void {
  const expectedRoles = ["monitor", "control", "shortcuts"] as const;
  const tabIds = new Set<string>();
  const groupIds = new Set<string>();
  const itemIds = new Set<string>();

  config.tabs.forEach((tab, tabIndex) => {
    if (tab.role !== expectedRoles[tabIndex]) {
      context.addIssue({
        code: "custom",
        path: ["tabs", tabIndex, "role"],
        message: `Tab order must be monitor, control, shortcuts`,
      });
    }
    if (tabIds.has(tab.id)) {
      context.addIssue({ code: "custom", path: ["tabs"], message: `Duplicate tab id: ${tab.id}` });
    }
    tabIds.add(tab.id);

    tab.groups.forEach((group, groupIndex) => {
      if (groupIds.has(group.id)) {
        context.addIssue({ code: "custom", path: ["tabs", tabIndex, "groups"], message: `Duplicate group id: ${group.id}` });
      }
      groupIds.add(group.id);
      if (group.kind === "app" && !group.applicationId) {
        context.addIssue({ code: "custom", path: ["tabs", tabIndex, "groups", groupIndex], message: `App group requires applicationId: ${group.id}` });
      }
      if (group.applicationId && !config.applications[group.applicationId]) {
        context.addIssue({ code: "custom", path: ["tabs", tabIndex, "groups", groupIndex], message: `Unknown application id: ${group.applicationId}` });
      }

      group.items.forEach((item) => {
        if (itemIds.has(item.id)) {
          context.addIssue({ code: "custom", path: ["tabs", tabIndex, "groups", groupIndex], message: `Duplicate item id: ${item.id}` });
        }
        itemIds.add(item.id);
        validateItem(item, `${tab.id}/${group.id}/${item.id}`, config.actions, context, ["tabs", tabIndex, "groups", groupIndex]);
      });
    });
  });

  for (const [actionId, action] of Object.entries(config.actions)) {
    if (action.type === "launchApp") {
      const referenceCount = Number(Boolean(action.applicationId)) + Number(Boolean(action.bundleId));
      if (referenceCount !== 1) {
        context.addIssue({ code: "custom", path: ["actions", actionId], message: "launchApp requires exactly one applicationId or bundleId" });
      }
      if (action.applicationId && !config.applications[action.applicationId]) {
        context.addIssue({ code: "custom", path: ["actions", actionId], message: `Unknown application id: ${action.applicationId}` });
      }
    }
    if (action.type === "appShortcut" && !config.applications[action.applicationId]) {
      context.addIssue({ code: "custom", path: ["actions", actionId], message: `Unknown application id: ${action.applicationId}` });
    }
  }
}

function validateItem(
  item: z.infer<typeof dashboardItemSchema>,
  qualifiedId: string,
  actions: Record<string, z.infer<typeof actionSchema>>,
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  if ("actionId" in item && !actions[item.actionId]) {
    context.addIssue({ code: "custom", path, message: `Unknown action id: ${item.actionId}` });
  }
  if (item.type === "slider" && item.min >= item.max) {
    context.addIssue({ code: "custom", path, message: `Invalid slider range: ${qualifiedId}` });
  }
}

function migrateLegacyConfig(config: z.infer<typeof legacyTouchBarConfigSchema>): TouchBarConfig {
  const monitorProfiles = config.profiles.filter((profile) => profile.id === "monitor");
  const controlProfiles = config.profiles.filter((profile) => profile.id !== "monitor");
  const toGroups = (profiles: typeof config.profiles): DashboardGroup[] => profiles.map((profile) => ({
    id: `legacy_${profile.id}`,
    title: profile.title,
    icon: profile.icon,
    kind: "section",
    columns: Math.max(1, Math.min(6, profile.columns)),
    items: profile.items,
  }));

  return touchBarConfigV2Schema.parse({
    version: 2,
    server: config.server,
    applications: {},
    tabs: [
      { id: "monitor", role: "monitor", title: "系统监控", icon: "📊", groups: toGroups(monitorProfiles) },
      { id: "control", role: "control", title: "控制", icon: "◉", groups: toGroups(controlProfiles) },
      { id: "shortcuts", role: "shortcuts", title: "快捷方式", icon: "↗", groups: [] },
    ],
    actions: config.actions,
  });
}

export interface DeviceRecord {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface CapabilityMap {
  media: boolean;
  volume: boolean;
  brightness: boolean;
  system: boolean;
  launchApp: boolean;
  openUrl: boolean;
  keystroke: boolean;
  appShortcut: boolean;
  bttTrigger: boolean;
}

export type ActionAvailabilityCode = "available" | "permission_required" | "app_missing" | "unsupported" | "misconfigured";
export interface ActionAvailability {
  available: boolean;
  code: ActionAvailabilityCode;
  message?: string;
}

export interface CodexTokenUsage {
  sessionTotalTokens: number;
  lastTurnTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  contextWindow: number;
  contextUsedPercent: number;
  quotaUsedPercent: number | null;
}

export interface CodexUsageTotals {
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface CodexModelUsage extends CodexUsageTotals {
  model: string;
}

export interface CodexDailyUsage extends CodexUsageTotals {
  date: string;
  updatedAt: string;
  models: CodexModelUsage[];
}

/** Costs are local ccusage estimates, not billed amounts. */
export type AiCostStatus = "estimated" | "partial" | "unknown";
export type AiUsageState = "loading" | "ready" | "stale" | "error";

export interface AiUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number | null;
  costStatus: AiCostStatus;
}

export interface AiModelUsage extends AiUsageTotals {
  model: string;
  sources: string[];
}

export interface AiDailyUsage {
  /** Stable across system refreshes; changes for every collector state mutation. */
  revision: string;
  date: string;
  timezone: string;
  currency: "USD";
  collector: "ccusage";
  collectorVersion: string;
  status: AiUsageState;
  lastSuccessfulRefreshAt: string | null;
  nextRefreshAt: string | null;
  error: string | null;
  /** Null means unavailable, not a zero-use day. */
  totals: AiUsageTotals | null;
  models: AiModelUsage[];
  sources: string[];
}

export interface MacSystemStatus {
  hostname: string;
  macosVersion: string;
  lanAddress: string | null;
  cpuPercent: number | null;
  loadAverage1m: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  memoryPercent: number;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  diskPercent: number | null;
  batteryPercent: number | null;
  batteryCharging: boolean | null;
  systemUptimeSeconds: number;
  agentUptimeSeconds: number;
  connectedClients: number;
  actionCount: number;
  /** @deprecated v1.2 compatibility field; no longer polled. */
  codexDailyUsage: CodexDailyUsage | null;
  aiDailyUsage?: AiDailyUsage | null;
  /** @deprecated v1.1 compatibility field. */
  codexTokens?: CodexTokenUsage | null;
  timestamp: string;
}

export interface TouchBarStatus {
  connected: boolean;
  volume: number | null;
  muted: boolean | null;
  lastAction: ActionResult | null;
  system: MacSystemStatus | null;
  timestamp: string;
}

export type ActionOutcome = "verified" | "accepted" | "failed";
export type ActionResultCode =
  | "ok"
  | "unauthorized"
  | "not_found"
  | "invalid_value"
  | "unsupported"
  | "permission_required"
  | "app_missing"
  | "misconfigured"
  | "activation_failed"
  | "execution_failed";

export interface ActionResult {
  requestId: string;
  actionId: string;
  ok: boolean;
  outcome: ActionOutcome;
  code: ActionResultCode;
  message: string;
  timestamp: string;
}

export interface BootstrapResponse {
  version: string;
  applications: Record<string, ApplicationDefinition>;
  tabs: DashboardTab[];
  /** @deprecated v1.1 compatibility field, flattened from tabs. */
  profiles: Profile[];
  capabilities: CapabilityMap;
  actionCapabilities: Record<string, boolean>;
  actionAvailability: Record<string, ActionAvailability>;
  status: TouchBarStatus;
}

export type ClientMessage =
  | { type: "auth"; token: string; deviceId: string }
  | { type: "ping" };

export type ServerMessage =
  | { type: "authResult"; ok: boolean; message?: string }
  | { type: "snapshot"; payload: BootstrapResponse }
  | { type: "status"; payload: TouchBarStatus }
  | { type: "actionResult"; payload: ActionResult }
  | { type: "capabilitiesChanged"; payload: CapabilityMap }
  | { type: "configChanged"; payload: Pick<BootstrapResponse, "applications" | "tabs" | "profiles"> }
  | { type: "pong" };

export const pairRequestSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  deviceName: z.string().trim().min(1).max(80),
  deviceId: z.string().uuid().optional(),
});

export const executeActionRequestSchema = z.object({
  requestId: z.string().uuid(),
  value: z.number().min(0).max(100).optional(),
});

export interface PairResponse {
  deviceId: string;
  token: string;
  expiresAt: null;
}
