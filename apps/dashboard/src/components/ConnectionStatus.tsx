import type { TelemetryConnectionStatus, TelemetrySnapshot } from "../telemetry/telemetryTypes";

type Props = {
  status: TelemetryConnectionStatus;
  snapshot: TelemetrySnapshot | null;
  renderHz: number;
};

export function ConnectionStatus({ status, snapshot, renderHz }: Props) {
  const isLive = status === "connected" && snapshot?.connected;
  const label = isLive ? "Live" : snapshot && !snapshot.connected ? "stale" : status;
  const lastUpdate = snapshot ? new Date(snapshot.timestamp).toLocaleTimeString() : "No data";

  return (
    <section className="connection-strip" aria-label="Connection status">
      <div className={`status-dot ${isLive ? "status-dot-live" : "status-dot-off"}`} />
      <div>
        <div className="status-label">{label}</div>
        <div className="status-meta">Render {renderHz}Hz · Last {lastUpdate}</div>
      </div>
    </section>
  );
}
