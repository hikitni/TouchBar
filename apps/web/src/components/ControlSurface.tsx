import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type {
  ActionAvailability,
  ActionResult,
  AiDailyUsage,
  AiModelUsage,
  ApplicationDefinition,
  DashboardGroup,
  DashboardItem,
  DashboardTab,
  TouchBarStatus,
} from "@touchbar/protocol";

interface ControlSurfaceProps {
  tab: DashboardTab;
  applications: Record<string, ApplicationDefinition>;
  status: TouchBarStatus;
  online: boolean;
  actionAvailability: Record<string, ActionAvailability>;
  pendingActionIds: ReadonlySet<string>;
  onAction: (actionId: string, value?: number) => Promise<ActionResult | null>;
}

const SLIDER_THROTTLE_MS = 140;

function friendlyTime(timestamp: string | null | undefined): string {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  return Number.isNaN(date.valueOf()) ? "—" : date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let current = value;
  let index = 0;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current >= 10 || index === 0 ? current.toFixed(0) : current.toFixed(1)} ${units[index]}`;
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}天 ${hours}小时`;
  if (hours > 0) return `${hours}小时 ${minutes}分钟`;
  return `${minutes}分钟`;
}

function formatCost(costUsd: number | null, status: "estimated" | "partial" | "unknown", model = false): string {
  if (costUsd === null || status === "unknown") return model ? "价格待确认" : "—";
  return `$${costUsd.toFixed(4)}${status === "partial" ? "（部分估算）" : ""}`;
}

function outcomeLabel(result: ActionResult): string {
  if (result.outcome === "accepted") return "已发送";
  if (result.outcome === "verified") return "已验证";
  return "失败";
}

function StatusItem({ item, status, online, compact = false }: {
  item: Extract<DashboardItem, { type: "status" }>;
  status: TouchBarStatus;
  online: boolean;
  compact?: boolean;
}) {
  const system = status.system;
  let value = "—";
  switch (item.statusKey) {
    case "connection":
      value = online ? (status.connected ? "Mac 已连接" : "Mac 不可用") : "正在重连";
      break;
    case "volume":
      value = status.volume === null ? "不可用" : `${Math.round(status.volume)}%${status.muted ? " · 已静音" : ""}`;
      break;
    case "time":
      value = friendlyTime(status.timestamp);
      break;
    case "lastAction":
      value = status.lastAction ? `${outcomeLabel(status.lastAction)} · ${status.lastAction.message}` : "等待操作";
      break;
    case "cpu":
      value = system?.cpuPercent === null || !system ? "采集中" : `${system.cpuPercent}% · 负载 ${system.loadAverage1m}`;
      break;
    case "memory":
      value = system ? `${formatBytes(system.memoryUsedBytes)} / ${formatBytes(system.memoryTotalBytes)} · ${system.memoryPercent}%` : "采集中";
      break;
    case "disk":
      value = system?.diskPercent === null || !system ? "不可用" : `${formatBytes(system.diskUsedBytes ?? 0)} / ${formatBytes(system.diskTotalBytes ?? 0)} · ${system.diskPercent}%`;
      break;
    case "battery":
      value = system?.batteryPercent === null || !system ? "未检测到电池" : `${system.batteryPercent}%${system.batteryCharging ? " · 充电中" : ""}`;
      break;
    case "uptime":
      value = system ? `系统 ${formatDuration(system.systemUptimeSeconds)} · Agent ${formatDuration(system.agentUptimeSeconds)}` : "采集中";
      break;
    case "network":
      value = system ? system.lanAddress ?? "无局域网地址" : "采集中";
      break;
    case "systemInfo":
      value = system ? `${system.hostname} · macOS ${system.macosVersion}` : "采集中";
      break;
    case "codexTokens":
    case "tokenQuota":
      value = system?.aiDailyUsage === undefined
        ? "此 Mac 尚未提供 AI 用量数据"
        : "AI 用量请查看今日 AI 用量面板";
      break;
    case "actions":
      value = system ? `${system.actionCount} 次操作 · ${system.connectedClients} 台在线设备` : "采集中";
      break;
  }

  return (
    <div className={`touch-status ${compact ? "compact-status" : ""} ${item.className ?? ""}`} title={value} data-status-key={item.statusKey}>
      {item.icon && <b className="status-icon" aria-hidden="true">{item.icon}</b>}
      {item.label && <span>{item.label}</span>}
      <strong>{value}</strong>
    </div>
  );
}

function UsageMetric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div className={`token-metric ${accent ? "accent" : ""}`}><span>{label}</span><strong>{value}</strong></div>;
}

function modelCells(model: AiModelUsage) {
  return [
    ["总计", formatCompact(model.totalTokens)],
    ["输入", formatCompact(model.inputTokens)],
    ["输出", formatCompact(model.outputTokens)],
    ["缓存读取", formatCompact(model.cacheReadTokens)],
    ["缓存创建", formatCompact(model.cacheCreationTokens)],
    ["费用", formatCost(model.costUsd, model.costStatus, true)],
  ] as const;
}

function ModelUsageRow({ model }: { model: AiModelUsage }) {
  return <tr><td title={model.model}>{model.model}</td><td>{model.sources.join("、") || "—"}</td>{modelCells(model).map(([label, value]) => <td key={label}>{value}</td>)}</tr>;
}

function ModelUsageCard({ model }: { model: AiModelUsage }) {
  return <article className="model-card"><header><strong>{model.model}</strong><span>{model.sources.join("、") || "—"}</span></header><dl>{modelCells(model).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></article>;
}

export function tokenUsagePropsEqual(
  previous: Readonly<{ usage: AiDailyUsage | null | undefined }>,
  next: Readonly<{ usage: AiDailyUsage | null | undefined }>,
): boolean {
  if (previous.usage === next.usage) return true;
  if (previous.usage === null || previous.usage === undefined || next.usage === null || next.usage === undefined) return false;
  return previous.usage.revision === next.usage.revision;
}

export const TokenUsagePanel = memo(function TokenUsagePanel({ usage }: { usage: AiDailyUsage | null | undefined }) {
  if (usage === undefined) {
    return <section className="token-panel token-state" aria-label="今日 AI 用量"><p>当前 Mac 尚未提供 AI 用量数据（兼容模式）。</p></section>;
  }
  if (usage === null) {
    return <section className="token-panel token-state" aria-label="今日 AI 用量"><p>正在等待 AI 用量采集器初始化…</p></section>;
  }

  const detail = usage.error ? <p className="token-error" role={usage.status === "error" ? "alert" : "status"}>{usage.error}</p> : null;
  if (usage.totals === null) {
    const message = usage.status === "loading"
      ? "正在读取 ccusage 今日用量…"
      : usage.status === "error"
        ? "暂时无法读取 AI 用量。"
        : "暂无可显示的 AI 用量数据。";
    return (
      <section className="token-panel token-state" aria-label="今日 AI 用量">
        <p>{message}</p>{detail}
        <UsageMeta usage={usage} />
      </section>
    );
  }

  const totals = usage.totals;
  return (
    <section className="token-panel" aria-label="今日 AI 用量">
      {(usage.status === "stale" || usage.status === "error") && (
        <p className="token-error" role={usage.status === "error" ? "alert" : "status"}>
          {usage.status === "stale" ? "显示上次成功采集的数据。" : "采集失败，显示保留的数据。"}{usage.error ? ` ${usage.error}` : ""}
        </p>
      )}
      <div className="token-summary">
        <UsageMetric label={totals.costStatus === "partial" ? "估算费用（部分）" : "估算费用"} value={formatCost(totals.costUsd, totals.costStatus)} accent />
        <UsageMetric label="总 Token" value={formatCompact(totals.totalTokens)} />
        <UsageMetric label="输入 Token" value={formatCompact(totals.inputTokens)} />
        <UsageMetric label="输出 Token" value={formatCompact(totals.outputTokens)} />
      </div>
      {totals.totalTokens === 0 && <p className="token-zero">今天尚无 AI 使用记录。</p>}
      <div className="token-breakdown" aria-label="AI 用量补充信息">
        <span>缓存读取 <strong>{formatCompact(totals.cacheReadTokens)}</strong></span>
        <span>缓存创建 <strong>{formatCompact(totals.cacheCreationTokens)}</strong></span>
        <span>模型 <strong>{usage.models.length} 个</strong></span>
        <span>来源 <strong>{usage.sources.join("、") || "—"}</strong></span>
      </div>
      <UsageMeta usage={usage} />
      <p className="privacy-note">USD 估算费用，非实际扣费账单</p>
      {usage.models.length > 0 && <div className="model-usage" data-swipe-ignore>
        <div className="model-table-wrap">
          <table className="model-table">
            <thead><tr><th>模型</th><th>来源</th><th>总计</th><th>输入</th><th>输出</th><th>缓存读取</th><th>缓存创建</th><th>费用</th></tr></thead>
            <tbody>{usage.models.map((model) => <ModelUsageRow key={model.model} model={model} />)}</tbody>
          </table>
        </div>
        <div className="model-cards">{usage.models.map((model) => <ModelUsageCard key={model.model} model={model} />)}</div>
      </div>}
    </section>
  );
}, tokenUsagePropsEqual);

function UsageMeta({ usage }: { usage: AiDailyUsage }) {
  return (
    <div className="token-meta">
      <span>上次成功 <strong>{friendlyTime(usage.lastSuccessfulRefreshAt)}</strong></span>
      <span>{usage.nextRefreshAt ? <>下次刷新 <strong>{friendlyTime(usage.nextRefreshAt)}</strong></> : "每 10 分钟刷新"}</span>
    </div>
  );
}

function SliderControl({ item, status, disabled, disabledReason, onAction }: {
  item: Extract<DashboardItem, { type: "slider" }>;
  status: TouchBarStatus;
  disabled: boolean;
  disabledReason?: string;
  onAction: (actionId: string, value?: number) => Promise<ActionResult | null>;
}) {
  const initialValue = status.volume ?? item.min;
  const [value, setValue] = useState(() => Math.min(item.max, Math.max(item.min, initialValue)));
  const pendingValue = useRef<number | null>(null);
  const timeout = useRef<number | null>(null);
  const lastSentAt = useRef(0);

  useEffect(() => {
    if (status.volume !== null && pendingValue.current === null) setValue(Math.min(item.max, Math.max(item.min, status.volume)));
  }, [item.max, item.min, status.volume]);
  useEffect(() => () => { if (timeout.current !== null) window.clearTimeout(timeout.current); }, []);

  const send = (nextValue: number) => {
    pendingValue.current = null;
    lastSentAt.current = Date.now();
    void onAction(item.actionId, nextValue);
  };
  const queue = (nextValue: number) => {
    pendingValue.current = nextValue;
    const elapsed = Date.now() - lastSentAt.current;
    if (timeout.current !== null) return;
    if (elapsed >= SLIDER_THROTTLE_MS) return send(nextValue);
    timeout.current = window.setTimeout(() => {
      timeout.current = null;
      if (pendingValue.current !== null) send(pendingValue.current);
    }, SLIDER_THROTTLE_MS - elapsed);
  };
  const flush = () => {
    if (timeout.current !== null) { window.clearTimeout(timeout.current); timeout.current = null; }
    if (pendingValue.current !== null) send(pendingValue.current);
  };

  return (
    <label className="slider-control" title={disabled ? disabledReason : undefined} data-swipe-ignore>
      <span>{item.icon && <b aria-hidden="true">{item.icon}</b>}{item.label ?? "音量"}</span>
      <div className="slider-row">
        <input aria-label={item.label ?? "音量"} type="range" min={item.min} max={item.max} step={item.step} value={value} disabled={disabled}
          onChange={(event) => { const nextValue = Number(event.target.value); setValue(nextValue); queue(nextValue); }}
          onPointerUp={flush} onTouchEnd={flush} onBlur={flush} />
        <output>{Math.round(value)}%</output>
      </div>
    </label>
  );
}

function DashboardItemView({ item, status, online, actionAvailability, pendingActionIds, onAction, compact }: {
  item: DashboardItem;
  status: TouchBarStatus;
  online: boolean;
  actionAvailability: Record<string, ActionAvailability>;
  pendingActionIds: ReadonlySet<string>;
  onAction: (actionId: string, value?: number) => Promise<ActionResult | null>;
  compact?: boolean;
}) {
  if (item.type === "spacer") return <div className="touch-spacer" aria-hidden="true" />;
  if (item.type === "status") return <StatusItem item={item} status={status} online={online} compact={compact} />;
  if (item.type === "tokenUsage") return <TokenUsagePanel usage={status.system?.aiDailyUsage} />;

  const availability = actionAvailability[item.actionId] ?? { available: true, code: "available" as const };
  const pending = pendingActionIds.has(item.actionId);
  const disabledReason = !online ? "实时连接恢复前暂不可用" : availability.message;
  if (item.type === "slider") return <SliderControl item={item} status={status} disabled={!online || !availability.available} disabledReason={disabledReason} onAction={onAction} />;

  return (
    <button type="button" data-swipe-ignore className={`touch-button ${item.className ?? ""} ${availability.available ? "" : "unsupported"} ${pending ? "pending" : ""}`}
      disabled={!online || !availability.available || pending} aria-busy={pending} title={disabledReason}
      onClick={() => {
        if (!online || pending) return;
        if (item.confirm && !window.confirm(`确认执行“${item.label ?? item.actionId}”吗？`)) return;
        void onAction(item.actionId);
      }}>
      {pending ? <span className="button-spinner" aria-hidden="true" /> : item.icon && <span className="button-icon" aria-hidden="true">{item.icon}</span>}
      <span>{pending ? "执行中…" : (item.label ?? item.actionId)}</span>
    </button>
  );
}

function GroupCard({ group, applications, status, online, actionAvailability, pendingActionIds, onAction }: {
  group: DashboardGroup;
  applications: Record<string, ApplicationDefinition>;
  status: TouchBarStatus;
  online: boolean;
  actionAvailability: Record<string, ActionAvailability>;
  pendingActionIds: ReadonlySet<string>;
  onAction: (actionId: string, value?: number) => Promise<ActionResult | null>;
}) {
  const application = group.applicationId ? applications[group.applicationId] : undefined;
  const isAiUsage = group.items.some((item) => item.type === "tokenUsage");
  const isDetails = group.presentation === "details";
  const warnings = useMemo(() => [...new Set(group.items.flatMap((item) => {
    if (!("actionId" in item)) return [];
    const availability = actionAvailability[item.actionId];
    return availability && !availability.available && availability.message ? [availability.message] : [];
  }))], [actionAvailability, group.items]);
  const updatedAt = isAiUsage ? status.system?.aiDailyUsage?.lastSuccessfulRefreshAt : status.system?.timestamp ?? status.timestamp;

  return (
    <article className={`dashboard-group ${group.kind} ${isDetails ? "details" : "tiles"} ${group.span === "full" || isAiUsage ? "full-span" : ""}`}>
      <header className="group-header">
        <div className="group-icon" aria-hidden="true">{application?.icon ?? group.icon ?? "•"}</div>
        <div><h2>{application?.name ?? group.title}</h2>{group.description && <p>{group.description}</p>}</div>
        {group.kind === "app" && <span className="app-badge">APP</span>}
        {group.kind === "metrics" && <time dateTime={updatedAt ?? undefined}>更新 {friendlyTime(updatedAt)}</time>}
      </header>
      {warnings.length > 0 && <div className="group-warning" role="note">{warnings.join("；")}</div>}
      <div className="touch-grid" style={{ "--columns": group.columns, "--items": group.items.filter((item) => item.type !== "spacer").length } as CSSProperties}>
        {group.items.map((item) => <DashboardItemView key={item.id} item={item} status={status} online={online} actionAvailability={actionAvailability} pendingActionIds={pendingActionIds} onAction={onAction} compact={isDetails} />)}
      </div>
    </article>
  );
}

export function ControlSurface({ tab, applications, status, online, actionAvailability, pendingActionIds, onAction }: ControlSurfaceProps) {
  if (tab.groups.length === 0) return <div className="empty-tab">此页面尚未配置内容。</div>;
  return (
    <section className={`dashboard-groups dashboard-${tab.role}`} aria-label={`${tab.title}面板`}>
      {tab.groups.map((group) => <GroupCard key={group.id} group={group} applications={applications} status={status} online={online} actionAvailability={actionAvailability} pendingActionIds={pendingActionIds} onAction={onAction} />)}
    </section>
  );
}
