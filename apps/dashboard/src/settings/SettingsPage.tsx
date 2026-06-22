import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ConfigResponse,
  ConfigSaveResponse,
  DashboardUrls,
  ServerConfig,
  StatusResponse
} from "./settingsTypes";

type Notice = {
  tone: "ok" | "warn" | "error";
  text: string;
};

function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isReservedForzaPort(value: number): boolean {
  return value >= 5200 && value <= 5300;
}

const DASHBOARD_LAYOUT_LABELS: Record<ServerConfig["dashboardLayout"], string> = {
  race: "GT / Race Dash",
  "time-attack": "Time Attack",
  engineer: "Telemetry Engineer",
  "mobile-race": "Mobile Landscape Race",
  minimal: "Minimal HUD",
  gforce: "G-Force Focus"
};

const DASHBOARD_LAYOUT_DESCRIPTIONS: Record<ServerConfig["dashboardLayout"], string> = {
  race: "Default motorsport screen for speed, gear, tires, inputs, and G-force.",
  "time-attack": "Lap-focused screen for current lap, delta, best lap, and key driving inputs.",
  engineer: "Dense validation screen for packet, vehicle, tire, powertrain, and motion values.",
  "mobile-race": "Compact landscape screen for phones with tires/race info, gear, speed, and G-force.",
  minimal: "Low-distraction auxiliary display with large gear, speed, RPM, and warnings.",
  gforce: "Load-transfer display centered on the G-force meter and acceleration values."
};

function dashboardLayoutLabel(layout: ServerConfig["dashboardLayout"]): string {
  return DASHBOARD_LAYOUT_LABELS[layout] ?? layout;
}

function dashboardLayoutDescription(layout: ServerConfig["dashboardLayout"]): string {
  return DASHBOARD_LAYOUT_DESCRIPTIONS[layout] ?? layout;
}

function validateConfig(
  config: ServerConfig,
  supportedAdapters: string[],
  supportedDashboardLayouts: string[]
): string[] {
  const errors: string[] = [];

  if (!supportedAdapters.includes(config.gameAdapter)) {
    errors.push("Game Adapter is not supported.");
  }
  if (!isValidPort(config.udpPort)) {
    errors.push("UDP Port must be between 1 and 65535.");
  }
  if (!isValidPort(config.httpPort)) {
    errors.push("HTTP Port must be between 1 and 65535.");
  }
  if (config.udpPort === config.httpPort) {
    errors.push("UDP Port and HTTP Port must be different.");
  }
  if (
    !Number.isInteger(config.udpReceiveBufferBytes) ||
    config.udpReceiveBufferBytes < 8192 ||
    config.udpReceiveBufferBytes > 67108864
  ) {
    errors.push("UDP Receive Buffer must be between 8 KiB and 64 MiB.");
  }
  if (
    !Number.isFinite(config.broadcastHz) ||
    (config.broadcastHz !== 0 && (config.broadcastHz < 1 || config.broadcastHz > 240))
  ) {
    errors.push("Broadcast Hz must be 0 for uncapped or between 1 and 240.");
  }
  if (config.transportMode !== "json" && config.transportMode !== "binary") {
    errors.push("Transport Mode must be JSON or Binary.");
  }
  if (!supportedDashboardLayouts.includes(config.dashboardLayout)) {
    errors.push("Dashboard Layout is not supported.");
  }
  if (
    !Number.isInteger(config.dashboardRenderHz) ||
    config.dashboardRenderHz < 1 ||
    config.dashboardRenderHz > 240
  ) {
    errors.push("Dashboard Render Hz must be between 1 and 240.");
  }
  if (
    !Number.isInteger(config.websocketSendTimeoutMs) ||
    config.websocketSendTimeoutMs < 10 ||
    config.websocketSendTimeoutMs > 1000
  ) {
    errors.push("WebSocket Send Timeout must be between 10 and 1000 ms.");
  }
  if (!Number.isFinite(config.connectionTimeoutMs) || config.connectionTimeoutMs < 500) {
    errors.push("Connection Timeout must be at least 500 ms.");
  }
  if (!config.udpHost.trim()) {
    errors.push("UDP Host is required.");
  }
  if (!config.httpHost.trim()) {
    errors.push("HTTP Host is required.");
  }

  return errors;
}

function formatTime(timestamp: number | null | undefined): string {
  if (!timestamp) {
    return "No packet";
  }
  return new Date(timestamp).toLocaleTimeString();
}

function formatOptionalNumber(value: number | null | undefined, fractionDigits = 1): string {
  if (value == null || !Number.isFinite(value)) {
    return "--";
  }
  return value.toFixed(fractionDigits);
}

function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "--";
  }
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  }
  return `${Math.round(value / 1024)} KiB`;
}

function formatBroadcastSetting(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "--";
  }
  return value === 0 ? "Uncapped" : `${value} Hz`;
}

function formatGapHistogram(status: StatusResponse | null): string {
  const histogram = status?.packetGapHistogram;
  if (!histogram) {
    return "--";
  }

  return [
    `<=8:${histogram.le8Ms}`,
    `<=16:${histogram.le16Ms}`,
    `<=33:${histogram.le33Ms}`,
    `<=50:${histogram.le50Ms}`,
    `<=100:${histogram.le100Ms}`,
    `<=250:${histogram.le250Ms}`,
    `>250:${histogram.gt250Ms}`
  ].join(" ");
}

function formatRecentPacketGaps(status: StatusResponse | null): string {
  const gaps = status?.recentPacketGaps;
  if (!gaps || gaps.length === 0) {
    return "None";
  }

  return gaps
    .slice(-4)
    .map((gap) => `${gap.gapMs}ms @ ${formatTime(gap.at)}`)
    .join(" | ");
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = typeof payload.error === "string" ? payload.error : response.statusText;
    const details = Array.isArray(payload.details) ? ` ${payload.details.join(" ")}` : "";
    throw new Error(`${error}${details}`.trim());
  }

  return payload as T;
}

function UrlBox({
  label,
  url,
  onCopy
}: {
  label: string;
  url: string;
  onCopy: (url: string) => void;
}) {
  return (
    <div className="settings-url-row">
      <div>
        <span>{label}</span>
        <strong>{url}</strong>
      </div>
      <button type="button" onClick={() => onCopy(url)}>
        Copy
      </button>
      <button type="button" onClick={() => window.open(url, "_blank", "noopener,noreferrer")}>
        Open
      </button>
    </div>
  );
}

function DashboardLayoutPreview({ layout }: { layout: ServerConfig["dashboardLayout"] }) {
  return (
    <div className={`settings-layout-preview preview-${layout}`} aria-hidden="true">
      {layout === "race" ? (
        <>
          <span className="preview-strip" />
          <span className="preview-stack preview-left" />
          <span className="preview-hero preview-center" />
          <span className="preview-ring preview-right" />
        </>
      ) : layout === "time-attack" ? (
        <>
          <span className="preview-strip" />
          <span className="preview-wide preview-top" />
          <span className="preview-wide preview-mid" />
          <span className="preview-row preview-bottom" />
        </>
      ) : layout === "engineer" ? (
        <>
          <span className="preview-grid preview-grid-a" />
          <span className="preview-grid preview-grid-b" />
          <span className="preview-grid preview-grid-c" />
          <span className="preview-stack preview-right" />
        </>
      ) : layout === "mobile-race" ? (
        <>
          <span className="preview-stack preview-left" />
          <span className="preview-hero preview-center" />
          <span className="preview-ring preview-right" />
          <span className="preview-row preview-bottom" />
        </>
      ) : layout === "minimal" ? (
        <>
          <span className="preview-hero preview-left" />
          <span className="preview-hero preview-center-wide" />
          <span className="preview-row preview-bottom" />
        </>
      ) : layout === "gforce" ? (
        <>
          <span className="preview-stack preview-left" />
          <span className="preview-ring preview-center-ring" />
          <span className="preview-stack preview-right" />
        </>
      ) : (
        null
      )}
    </div>
  );
}

function DashboardLayoutGallery({
  currentLayout,
  layouts,
  dashboardUrl,
  onSelect
}: {
  currentLayout: ServerConfig["dashboardLayout"];
  layouts: ServerConfig["dashboardLayout"][];
  dashboardUrl: string;
  onSelect: (layout: ServerConfig["dashboardLayout"]) => void;
}) {
  const baseDashboardUrl = dashboardUrl || "/dashboard";

  const previewUrl = (layout: ServerConfig["dashboardLayout"]) => {
    const separator = baseDashboardUrl.includes("?") ? "&" : "?";
    return `${baseDashboardUrl}${separator}layout=${layout}`;
  };

  return (
    <section className="settings-layout-gallery" aria-label="Dashboard layout gallery">
      {layouts.map((layout) => {
        const selected = layout === currentLayout;
        const url = previewUrl(layout);
        return (
          <article className={`settings-layout-card ${selected ? "layout-card-selected" : ""}`} key={layout}>
            <DashboardLayoutPreview layout={layout} />
            <div>
              <span>{layout}</span>
              <strong>{dashboardLayoutLabel(layout)}</strong>
              <p>{dashboardLayoutDescription(layout)}</p>
            </div>
            <div className="settings-layout-actions">
              <button type="button" onClick={() => onSelect(layout)} disabled={selected}>
                {selected ? "Selected" : "Use"}
              </button>
              <button type="button" onClick={() => window.open(url, "_blank", "noopener,noreferrer")}>
                Preview
              </button>
            </div>
          </article>
        );
      })}
    </section>
  );
}

function StatusGrid({ status }: { status: StatusResponse | null }) {
  const rows = [
    ["App running", status?.appRunning ? "Yes" : "No"],
    ["Telemetry running", status?.telemetryRunning ? "Yes" : "No"],
    ["UDP listening", status?.udpListeningAddress ?? "Stopped"],
    ["HTTP listening", status?.httpListeningAddress ?? "--"],
    ["Game connected", status?.gameConnected ? "Yes" : "No"],
    ["WebSocket clients", String(status?.websocketClients ?? 0)],
    ["Broadcast", formatBroadcastSetting(status?.broadcastHz)],
    ["Transport", status?.transportMode === "binary" ? "Binary low latency" : "JSON compatible"],
    ["Dashboard layout", status?.dashboardLayout ? dashboardLayoutLabel(status.dashboardLayout) : "--"],
    ["Dashboard render", `${status?.dashboardRenderHz ?? "--"} Hz`],
    ["Broadcast actual", `${formatOptionalNumber(status?.broadcastStats?.estimatedBroadcastHz, 1)} Hz`],
    ["Broadcast requests", String(status?.broadcastStats?.broadcastRequestCount ?? 0)],
    ["Broadcast frames", String(status?.broadcastStats?.broadcastCount ?? 0)],
    ["Coalesced requests", String(status?.broadcastStats?.coalescedBroadcastRequests ?? 0)],
    [
      "Snapshot age at send",
      status?.broadcastStats?.lastSnapshotAgeMsAtBroadcast == null
        ? "--"
        : `${status.broadcastStats.lastSnapshotAgeMsAtBroadcast} ms`
    ],
    ["Snapshot age max", `${status?.broadcastStats?.maxSnapshotAgeMsAtBroadcast ?? 0} ms`],
    ["Payload", formatBytes(status?.broadcastStats?.lastPayloadBytes)],
    ["WS timeout setting", `${status?.websocketSendTimeoutMs ?? "--"} ms`],
    ["WS send max", `${formatOptionalNumber(status?.broadcastStats?.maxWebsocketSendMs, 1)} ms`],
    ["WS send timeouts", String(status?.broadcastStats?.websocketSendTimeouts ?? 0)],
    ["WS send errors", String(status?.broadcastStats?.websocketSendErrors ?? 0)],
    ["Packets", String(status?.receivedPacketCount ?? 0)],
    ["Last packet", formatTime(status?.lastPacketAt)],
    ["Last packet age", status?.lastPacketAgeMs == null ? "--" : `${status.lastPacketAgeMs} ms`],
    ["Estimated UDP Hz", formatOptionalNumber(status?.estimatedPacketHz, 1)],
    ["UDP gap max", `${status?.maxPacketGapMs ?? 0} ms`],
    ["UDP gap events", String(status?.packetGapCount ?? 0)],
    ["UDP gap distribution", formatGapHistogram(status)],
    ["Recent UDP gaps", formatRecentPacketGaps(status)],
    ["UDP receive buffer", formatBytes(status?.udpReceiveBufferBytes)],
    ["Mock mode", status?.mockTelemetry ? "On" : "Off"]
  ];

  return (
    <section className="settings-panel">
      <div className="settings-panel-heading">
        <h2>Runtime Status</h2>
      </div>
      <div className="settings-status-grid">
        {rows.map(([label, value]) => (
          <div className="settings-status-cell" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

export function SettingsPage() {
  const [form, setForm] = useState<ServerConfig | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [supportedAdapters, setSupportedAdapters] = useState<string[]>(["forza-horizon-6"]);
  const [supportedDashboardLayouts, setSupportedDashboardLayouts] = useState<ServerConfig["dashboardLayout"][]>([
    "race"
  ]);
  const [urls, setUrls] = useState<DashboardUrls | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);
  const [runtimeBusy, setRuntimeBusy] = useState(false);

  const refreshStatus = useCallback(async () => {
    const nextStatus = await readJson<StatusResponse>("/api/status");
    setStatus(nextStatus);
    setUrls(nextStatus.urls);
  }, []);

  const refreshConfig = useCallback(async () => {
    const response = await readJson<ConfigResponse>("/api/config");
    setForm(response.config);
    setSupportedAdapters(response.supportedGameAdapters);
    setSupportedDashboardLayouts(response.supportedDashboardLayouts);
    setUrls(response.urls);
  }, []);

  useEffect(() => {
    refreshConfig().catch((error) => setNotice({ tone: "error", text: error.message }));
    refreshStatus().catch((error) => setNotice({ tone: "error", text: error.message }));

    const timerId = window.setInterval(() => {
      refreshStatus().catch(() => undefined);
    }, 1000);

    return () => window.clearInterval(timerId);
  }, [refreshConfig, refreshStatus]);

  const validationErrors = useMemo(
    () => (form ? validateConfig(form, supportedAdapters, supportedDashboardLayouts) : []),
    [form, supportedAdapters, supportedDashboardLayouts]
  );

  const warnings = useMemo(() => {
    if (!form) {
      return [];
    }
    return isReservedForzaPort(form.udpPort)
      ? ["FH6 documentation recommends avoiding UDP ports 5200-5300. The default is 5400."]
      : [];
  }, [form]);

  const updateField = <Key extends keyof ServerConfig>(key: Key, value: ServerConfig[Key]) => {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  };

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setNotice({ tone: "ok", text: "URL copied." });
    } catch {
      setNotice({ tone: "warn", text: "Clipboard copy failed. Select and copy the URL manually." });
    }
  };

  const saveConfig = async () => {
    if (!form || validationErrors.length > 0) {
      setNotice({ tone: "error", text: validationErrors.join(" ") });
      return;
    }

    setSaving(true);
    setNotice(null);

    try {
      const response = await readJson<ConfigSaveResponse>("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form)
      });

      setForm(response.config);
      const restartText = response.requiresTelemetryRestart
        ? " Restart telemetry to apply UDP, receive buffer, mock, debug, or adapter changes."
        : "";
      const appRestartText = response.requiresAppRestart
        ? " Restart the app process to apply HTTP host or port changes."
        : "";
      setNotice({
        tone: response.requiresTelemetryRestart || response.requiresAppRestart ? "warn" : "ok",
        text: `Config saved. Broadcast, transport, dashboard layout, dashboard render, and WebSocket timeout changes apply immediately.${restartText}${appRestartText}`
      });
      await refreshStatus();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Save failed." });
    } finally {
      setSaving(false);
    }
  };

  const runtimeAction = async (action: "start" | "stop" | "restart") => {
    setRuntimeBusy(true);
    setNotice(null);

    try {
      await readJson(`/api/runtime/${action}`, { method: "POST" });
      await refreshStatus();
      setNotice({ tone: "ok", text: `Telemetry ${action} requested.` });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Runtime action failed." });
    } finally {
      setRuntimeBusy(false);
    }
  };

  if (!form) {
    return (
      <main className="settings-stage">
        <section className="settings-shell">
          <h1>Telemetry Settings</h1>
          <p className="settings-muted">Loading settings...</p>
        </section>
      </main>
    );
  }

  return (
    <main className="settings-stage">
      <section className="settings-shell">
        <header className="settings-header">
          <div>
            <p className="dash-kicker">SIM TELEMETRY SERVER</p>
            <h1>Settings</h1>
          </div>
          <div className="settings-actions">
            <button type="button" onClick={() => runtimeAction("start")} disabled={runtimeBusy}>
              Start
            </button>
            <button type="button" onClick={() => runtimeAction("stop")} disabled={runtimeBusy}>
              Stop
            </button>
            <button type="button" onClick={() => runtimeAction("restart")} disabled={runtimeBusy}>
              Restart
            </button>
          </div>
        </header>

        {notice ? <div className={`settings-notice notice-${notice.tone}`}>{notice.text}</div> : null}

        <div className="settings-grid">
          <section className="settings-panel">
            <div className="settings-panel-heading">
              <h2>Configuration</h2>
              <button type="button" onClick={saveConfig} disabled={saving || validationErrors.length > 0}>
                {saving ? "Saving" : "Save"}
              </button>
            </div>

            <DashboardLayoutGallery
              currentLayout={form.dashboardLayout}
              dashboardUrl={urls?.localDashboardUrl ?? "/dashboard"}
              layouts={supportedDashboardLayouts}
              onSelect={(layout) => updateField("dashboardLayout", layout)}
            />

            <div className="settings-form-grid">
              <label>
                <span>Game Adapter</span>
                <select
                  value={form.gameAdapter}
                  onChange={(event) => updateField("gameAdapter", event.target.value)}
                >
                  {supportedAdapters.map((adapter) => (
                    <option key={adapter} value={adapter}>
                      {adapter}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>Transport Mode</span>
                <select
                  value={form.transportMode}
                  onChange={(event) =>
                    updateField("transportMode", event.target.value as ServerConfig["transportMode"])
                  }
                >
                  <option value="json">JSON compatible</option>
                  <option value="binary">Binary low latency</option>
                </select>
                <small>Binary uses /ws/telemetry.bin and omits race/lap fields in v1.</small>
              </label>

              <label>
                <span>Dashboard Layout</span>
                <select
                  value={form.dashboardLayout}
                  onChange={(event) =>
                    updateField("dashboardLayout", event.target.value as ServerConfig["dashboardLayout"])
                  }
                >
                  {supportedDashboardLayouts.map((layout) => (
                    <option key={layout} value={layout}>
                      {dashboardLayoutLabel(layout)}
                    </option>
                  ))}
                </select>
                <small>Saved layout applies to /dashboard. URL query layout=... still overrides it temporarily.</small>
              </label>

              <label>
                <span>UDP Host</span>
                <input
                  value={form.udpHost}
                  onChange={(event) => updateField("udpHost", event.target.value)}
                />
              </label>

              <label>
                <span>UDP Port</span>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={form.udpPort}
                  onChange={(event) => updateField("udpPort", Number(event.target.value))}
                />
              </label>

              <label>
                <span>UDP Receive Buffer bytes</span>
                <input
                  type="number"
                  min={8192}
                  max={67108864}
                  step={8192}
                  value={form.udpReceiveBufferBytes}
                  onChange={(event) => updateField("udpReceiveBufferBytes", Number(event.target.value))}
                />
              </label>

              <label>
                <span>HTTP Host</span>
                <input
                  value={form.httpHost}
                  onChange={(event) => updateField("httpHost", event.target.value)}
                />
              </label>

              <label>
                <span>HTTP Port</span>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={form.httpPort}
                  onChange={(event) => updateField("httpPort", Number(event.target.value))}
                />
              </label>

              <label>
                <span>Broadcast Hz</span>
                <input
                  type="number"
                  min={0}
                  max={240}
                  value={form.broadcastHz}
                  onChange={(event) => updateField("broadcastHz", Number(event.target.value))}
                />
                <small>0 = uncapped, 1-240 = capped WebSocket send rate.</small>
              </label>

              <label>
                <span>Dashboard Render Hz</span>
                <input
                  type="number"
                  min={1}
                  max={240}
                  value={form.dashboardRenderHz}
                  onChange={(event) => updateField("dashboardRenderHz", Number(event.target.value))}
                />
                <small>Controls React state/render copy rate without reconnecting WebSocket.</small>
              </label>

              <label>
                <span>WebSocket Send Timeout ms</span>
                <input
                  type="number"
                  min={10}
                  max={1000}
                  value={form.websocketSendTimeoutMs}
                  onChange={(event) =>
                    updateField("websocketSendTimeoutMs", Number(event.target.value))
                  }
                />
                <small>Slow clients are dropped and auto-reconnect with the latest frame.</small>
              </label>

              <label>
                <span>Connection Timeout ms</span>
                <input
                  type="number"
                  min={500}
                  value={form.connectionTimeoutMs}
                  onChange={(event) => updateField("connectionTimeoutMs", Number(event.target.value))}
                />
              </label>
            </div>

            <div className="settings-toggle-row">
              <label>
                <input
                  type="checkbox"
                  checked={form.mockTelemetry}
                  onChange={(event) => updateField("mockTelemetry", event.target.checked)}
                />
                <span>Mock Telemetry</span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={form.debugPacket}
                  onChange={(event) => updateField("debugPacket", event.target.checked)}
                />
                <span>Debug Packet</span>
              </label>
            </div>

            {[...validationErrors, ...warnings].length > 0 ? (
              <div className="settings-validation">
                {[...validationErrors, ...warnings].map((message) => (
                  <p key={message}>{message}</p>
                ))}
              </div>
            ) : null}
          </section>

          <StatusGrid status={status} />
        </div>

        <section className="settings-panel">
          <div className="settings-panel-heading">
            <h2>Dashboard Access</h2>
          </div>
          <div className="settings-url-list">
            <UrlBox
              label="Local Dashboard"
              url={urls?.localDashboardUrl ?? "/dashboard"}
              onCopy={copyUrl}
            />
            <UrlBox
              label="Network Dashboard"
              url={urls?.networkDashboardUrl ?? "Check ipconfig for PC_LOCAL_IP, then open http://PC_LOCAL_IP:3000/dashboard"}
              onCopy={copyUrl}
            />
            <UrlBox
              label="Local Settings"
              url={urls?.localSettingsUrl ?? "/settings"}
              onCopy={copyUrl}
            />
          </div>
        </section>
      </section>
    </main>
  );
}
