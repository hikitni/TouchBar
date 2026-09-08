import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionOutcome, ActionResult, DashboardTab, TouchBarStatus } from "@touchbar/protocol";
import { ControlSurface } from "./components/ControlSurface";
import { PairingScreen } from "./components/PairingScreen";
import { useTouchBarClient } from "./hooks/useTouchBarClient";
import { loadSelectedTab, saveSelectedTab } from "./lib/storage";

const EMPTY_STATUS: TouchBarStatus = { connected: false, volume: null, muted: null, lastAction: null, system: null, timestamp: new Date(0).toISOString() };

function selectTab(tabs: DashboardTab[], savedId: string | null): DashboardTab | null {
  return tabs.find((tab) => tab.id === savedId) ?? tabs[0] ?? null;
}

function LoadingScreen() {
  return <main className="loading-shell" aria-live="polite"><div className="loading-orbit" aria-hidden="true" /><p>正在连接 Mac…</p></main>;
}

function ErrorScreen({ message, onRetry, onForget }: { message: string; onRetry: () => void; onForget: () => void }) {
  return <main className="loading-shell error-shell" role="alert"><div className="error-glyph" aria-hidden="true">!</div><h1>无法加载 Touch Bar</h1><p>{message}</p><div className="error-actions"><button type="button" className="pair-button" onClick={onRetry}>重试</button><button type="button" className="text-button" onClick={onForget}>重新配对设备</button></div></main>;
}

function outcomeView(outcome: ActionOutcome | undefined, ok: boolean) {
  const normalized = outcome ?? (ok ? "verified" : "failed");
  if (normalized === "accepted") return { className: "accepted", icon: "→", title: "指令已发送" };
  if (normalized === "verified") return { className: "verified", icon: "✓", title: "操作已验证" };
  return { className: "failure", icon: "!", title: "操作失败" };
}

interface Feedback { key: string; result: ActionResult; }
interface SwipeStart { x: number; y: number; ignored: boolean; direction: "pending" | "horizontal" | "vertical"; }

function ignoresSwipe(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button, input, [data-swipe-ignore], .model-table-wrap"));
}

export default function App() {
  const client = useTouchBarClient();
  const tabs = client.bootstrap?.tabs ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(() => loadSelectedTab());
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const swipeStart = useRef<SwipeStart | null>(null);
  const selectedTab = useMemo(() => selectTab(tabs, selectedId), [tabs, selectedId]);

  useEffect(() => {
    if (selectedTab && selectedTab.id !== selectedId) { setSelectedId(selectedTab.id); saveSelectedTab(selectedTab.id); }
  }, [selectedId, selectedTab]);

  useEffect(() => {
    if (!client.actionResult) return;
    const result = client.actionResult;
    const key = `${result.requestId}:${result.timestamp}:${result.outcome}`;
    setFeedback((current) => current?.key === key ? current : { key, result });
  }, [client.actionResult]);

  useEffect(() => {
    if (!feedback || feedback.result.outcome === "failed" || !feedback.result.ok) return;
    const key = feedback.key;
    const timer = window.setTimeout(() => setFeedback((current) => current?.key === key ? null : current), 5_000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const select = (id: string) => { setSelectedId(id); saveSelectedTab(id); };
  const selectByOffset = (offset: number) => {
    if (!selectedTab || tabs.length < 2) return;
    const index = tabs.findIndex((tab) => tab.id === selectedTab.id);
    const next = tabs[(index + offset + tabs.length) % tabs.length];
    if (next) select(next.id);
  };

  if (client.phase === "pairing") return <PairingScreen error={client.error} busy={false} onPair={client.pair} />;
  if (client.phase === "loading") return <LoadingScreen />;
  if (client.phase === "error") return <ErrorScreen message={client.error ?? "连接 Mac 时发生未知错误。"} onRetry={client.retry} onForget={client.forgetDevice} />;
  if (!client.bootstrap || !selectedTab) return <ErrorScreen message="Mac 没有返回可用的控制页面。" onRetry={client.retry} onForget={client.forgetDevice} />;

  const isBusy = client.pendingActionIds.size > 0;
  const feedbackView = feedback ? outcomeView(feedback.result.outcome, feedback.result.ok) : null;

  return (
    <main className="control-shell">
      <header className="control-header">
        <div className="identity"><span className="brand-mark small" aria-hidden="true">⌁</span><div><p className="eyebrow">MAC 副屏控制台 · v{client.bootstrap.version}</p><h1>{selectedTab.title}</h1></div></div>
        <div className={`connection-pill ${client.online ? "online" : "offline"}`} aria-live="polite"><i aria-hidden="true" />{client.online ? (client.bootstrap.status.connected ? "已连接" : "Mac 离线") : "正在重连"}</div>
      </header>
      <section className="feedback-area" aria-label="操作反馈">
        {!client.online && <p className="offline-notice" role="status">实时连接恢复前，控制按钮暂不可用。</p>}
        {(isBusy || feedback) && <div className={`result-banner ${isBusy ? "pending" : feedbackView?.className}`} role={feedbackView?.className === "failure" ? "alert" : "status"} aria-live="polite">
          <span className="result-icon" aria-hidden="true">{isBusy ? "◌" : feedbackView?.icon}</span>
          <div><strong>{isBusy ? "正在执行操作" : feedbackView?.title}</strong><small>{isBusy ? "请稍候，Mac 正在处理指令。" : feedback?.result.message}</small></div>
          {!isBusy && feedbackView?.className === "failure" && <button type="button" className="dismiss-feedback" onClick={() => setFeedback(null)} aria-label="关闭操作反馈">关闭</button>}
        </div>}
      </section>
      <div className="surface-wrap" aria-label={`${selectedTab.title}面板`}
        onPointerDown={(event) => { swipeStart.current = { x: event.clientX, y: event.clientY, ignored: ignoresSwipe(event.target), direction: "pending" }; }}
        onPointerMove={(event) => {
          const start = swipeStart.current;
          if (!start || start.ignored || start.direction !== "pending") return;
          const x = event.clientX - start.x; const y = event.clientY - start.y;
          if (Math.max(Math.abs(x), Math.abs(y)) >= 8) start.direction = Math.abs(x) > Math.abs(y) ? "horizontal" : "vertical";
        }}
        onPointerUp={(event) => {
          const start = swipeStart.current; swipeStart.current = null;
          if (!start || start.ignored || start.direction === "vertical") return;
          const x = event.clientX - start.x; const y = event.clientY - start.y;
          if (Math.abs(x) >= 45 && Math.abs(x) > Math.abs(y) && tabs.length > 1) selectByOffset(x < 0 ? 1 : -1);
        }}
        onPointerCancel={() => { swipeStart.current = null; }}>
        <ControlSurface tab={selectedTab} applications={client.bootstrap.applications} status={client.bootstrap.status ?? EMPTY_STATUS} online={client.online} actionAvailability={client.bootstrap.actionAvailability} pendingActionIds={client.pendingActionIds} onAction={client.invoke} />
      </div>
      <nav className="dashboard-tabs" aria-label="主功能" role="tablist">
        {tabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={tab.id === selectedTab.id} className={tab.id === selectedTab.id ? "active" : ""} onClick={() => select(tab.id)}><span className="tab-icon" aria-hidden="true">{tab.icon ?? "•"}</span><span>{tab.title}</span></button>)}
      </nav>
    </main>
  );
}
