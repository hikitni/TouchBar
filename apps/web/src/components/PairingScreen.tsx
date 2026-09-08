import { FormEvent, useMemo, useState } from "react";

interface PairingScreenProps {
  error: string | null;
  busy: boolean;
  onPair: (code: string, deviceName: string) => Promise<void>;
}

function suggestedDeviceName(): string {
  if (typeof navigator === "undefined") return "浏览器副屏";
  const platform = navigator.userAgent.includes("iPhone") ? "iPhone" : navigator.userAgent.includes("iPad") ? "iPad" : "浏览器";
  return `${platform}副屏`;
}

export function PairingScreen({ error, busy, onPair }: PairingScreenProps) {
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState(suggestedDeviceName);
  const [submitted, setSubmitted] = useState(false);
  const isCodeValid = /^\d{6}$/.test(code);
  const validationMessage = useMemo(() => {
    if (!submitted || isCodeValid) return null;
    return "请输入 Mac 端显示的六位配对码。";
  }, [isCodeValid, submitted]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (!isCodeValid || !deviceName.trim() || busy) return;
    await onPair(code, deviceName.trim()).catch(() => undefined);
  }

  return (
    <main className="pairing-shell">
      <section className="pairing-card" aria-labelledby="pairing-title">
        <div className="brand-mark" aria-hidden="true">⌁</div>
        <p className="eyebrow">MAC 副屏控制台 · v1.3</p>
        <h1 id="pairing-title">连接这台设备</h1>
        <p className="pairing-copy">输入 Mac 上 Touch Bar Agent 显示的六位配对码，建立局域网安全连接。</p>
        <form onSubmit={submit} noValidate>
          <label htmlFor="device-name">设备名称</label>
          <input
            id="device-name"
            value={deviceName}
            onChange={(event) => setDeviceName(event.target.value)}
            maxLength={80}
            autoComplete="nickname"
            disabled={busy}
          />
          <label htmlFor="pairing-code">配对码</label>
          <input
            id="pairing-code"
            className="pairing-code"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            placeholder="000000"
            aria-describedby="pairing-help"
            disabled={busy}
          />
          <p id="pairing-help" className="form-message" role={validationMessage || error ? "alert" : undefined}>
            {validationMessage ?? error ?? "配对码会在一段时间后失效。"}
          </p>
          <button className="pair-button" type="submit" disabled={busy || !isCodeValid || !deviceName.trim()}>
            {busy ? "正在连接…" : "连接 Mac"}
          </button>
        </form>
      </section>
    </main>
  );
}
