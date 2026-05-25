import type { CSSProperties } from "react";
import { SettingsPage } from "./settings/SettingsPage";
import type { TelemetryConnectionStatus, TelemetrySnapshot } from "./telemetry/telemetryTypes";
import { useTelemetry } from "./telemetry/useTelemetry";

type DashboardProps = {
  snapshot: TelemetrySnapshot | null;
  connectionStatus: TelemetryConnectionStatus;
  renderHz: number;
};

function numberOrDash(value: number | undefined, fractionDigits = 0): string {
  if (value == null || !Number.isFinite(value)) {
    return "--";
  }
  return value.toFixed(fractionDigits);
}

function percent(value: number | undefined): number {
  return Math.round(Math.max(0, Math.min(1, value ?? 0)) * 100);
}

function formatGear(gear: number): string {
  if (gear < 0) {
    return "R";
  }
  if (gear === 0) {
    return "N";
  }
  return String(gear);
}

function formatTime(timestamp: number | undefined): string {
  if (!timestamp) {
    return "--:--:--";
  }
  return new Date(timestamp).toLocaleTimeString();
}

function connectionLabel(status: TelemetryConnectionStatus, snapshot: TelemetrySnapshot | null): string {
  if (status === "connected" && snapshot?.connected) {
    return "LIVE";
  }
  if (snapshot && !snapshot.connected) {
    return "STALE";
  }
  return status.toUpperCase();
}

function shiftLightTone(index: number): string {
  if (index >= 18) {
    return "shift-blue";
  }
  if (index >= 14) {
    return "shift-red";
  }
  if (index >= 9) {
    return "shift-amber";
  }
  return "shift-green";
}

function ShiftLights({ rpm, maxRpm = 8000 }: { rpm: number; maxRpm?: number }) {
  const ratio = Math.max(0, Math.min(1, rpm / Math.max(maxRpm, 1)));

  return (
    <div className="shift-light-rail" aria-label="RPM shift lights">
      {Array.from({ length: 20 }, (_, index) => {
        const active = ratio >= (index + 1) / 20;
        return (
          <span
            className={`shift-light ${shiftLightTone(index)} ${active ? "shift-active" : ""}`}
            key={index}
          />
        );
      })}
    </div>
  );
}

function BarGauge({
  label,
  value,
  tone
}: {
  label: string;
  value: number | undefined;
  tone: "throttle" | "brake" | "clutch";
}) {
  const width = percent(value);
  const style = { "--bar-value": `${width}%` } as CSSProperties;

  return (
    <div className="race-bar-row">
      <span>{label}</span>
      <div className="race-bar-track">
        <div className={`race-bar-fill race-bar-${tone}`} style={style} />
      </div>
      <strong>{width}%</strong>
    </div>
  );
}

function SteerGauge({ value }: { value: number }) {
  const clamped = Math.max(-1, Math.min(1, value));
  const style = { "--steer-position": `${clamped * 50}%` } as CSSProperties;

  return (
    <div className="steer-gauge">
      <span>STEER</span>
      <div className="steer-slot">
        <div className="steer-zero" />
        <div className="steer-pointer" style={style} />
      </div>
      <strong>{Math.round(clamped * 100)}%</strong>
    </div>
  );
}

function TireMatrix({ tires }: { tires: TelemetrySnapshot["tires"] }) {
  const items = [
    ["FL", tires?.frontLeftTemp],
    ["FR", tires?.frontRightTemp],
    ["RL", tires?.rearLeftTemp],
    ["RR", tires?.rearRightTemp]
  ] as const;

  return (
    <section className="gt3-panel tire-matrix" aria-label="Tire temperatures">
      <div className="panel-title">TIRES C</div>
      <div className="tire-matrix-grid">
        {items.map(([label, value]) => (
          <div className="tire-matrix-cell" key={label}>
            <span>{label}</span>
            <strong>{numberOrDash(value, 1)}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function PowertrainPanel({ vehicle }: { vehicle: TelemetrySnapshot["vehicle"] }) {
  return (
    <section className="gt3-panel power-panel" aria-label="Powertrain">
      <div className="panel-title">POWERTRAIN</div>
      <div className="power-row">
        <span>POWER</span>
        <strong>{numberOrDash(vehicle.powerKw)} KW</strong>
      </div>
      <div className="power-row">
        <span>TORQUE</span>
        <strong>{numberOrDash(vehicle.torqueNm)} NM</strong>
      </div>
      <div className="power-row">
        <span>BOOST</span>
        <strong>{numberOrDash(vehicle.boost, 2)}</strong>
      </div>
    </section>
  );
}

function MotionPanel({ motion }: { motion: TelemetrySnapshot["motion"] }) {
  return (
    <section className="gt3-panel motion-panel" aria-label="Motion telemetry">
      <div className="panel-title">MOTION</div>
      <div className="power-row">
        <span>ACC X</span>
        <strong>{numberOrDash(motion?.accelX, 2)}</strong>
      </div>
      <div className="power-row">
        <span>ACC Y</span>
        <strong>{numberOrDash(motion?.accelY, 2)}</strong>
      </div>
      <div className="power-row">
        <span>ACC Z</span>
        <strong>{numberOrDash(motion?.accelZ, 2)}</strong>
      </div>
    </section>
  );
}

function Gt3Dashboard({ snapshot, connectionStatus, renderHz }: DashboardProps) {
  const rpm = snapshot?.vehicle.rpm ?? 0;
  const maxRpm = snapshot?.vehicle.maxRpm ?? 8000;
  const isLive = connectionStatus === "connected" && snapshot?.connected;

  return (
    <section className={`gt3-cluster ${isLive ? "cluster-live" : "cluster-off"}`}>
      <ShiftLights rpm={rpm} maxRpm={maxRpm} />

      <header className="cluster-header">
        <div>
          <p className="dash-kicker">FORZA DATA OUT</p>
          <h1>GT3 TELEMETRY</h1>
        </div>
        <div className="header-readouts">
          <div className="header-chip">
            <span>LINK</span>
            <strong>{connectionLabel(connectionStatus, snapshot)}</strong>
          </div>
          <div className="header-chip">
            <span>LAST</span>
            <strong>{formatTime(snapshot?.timestamp)}</strong>
          </div>
          <div className="header-chip">
            <span>RENDER</span>
            <strong>{renderHz}HZ</strong>
          </div>
        </div>
      </header>

      {!snapshot ? (
        <section className="gt3-waiting">Waiting for telemetry...</section>
      ) : (
        <section className="gt3-layout" aria-label="Telemetry dashboard">
          <div className="left-stack">
            <TireMatrix tires={snapshot.tires} />
            <section className="gt3-panel inputs-panel" aria-label="Driver inputs">
              <div className="panel-title">INPUTS</div>
              <BarGauge label="THR" value={snapshot.input.throttle} tone="throttle" />
              <BarGauge label="BRK" value={snapshot.input.brake} tone="brake" />
              <BarGauge label="CLT" value={snapshot.input.clutch} tone="clutch" />
              <SteerGauge value={snapshot.input.steer} />
            </section>
          </div>

          <section className="center-display" aria-label="Gear speed and RPM">
            <div className="center-top-readouts">
              <div>
                <span>RPM</span>
                <strong>{Math.round(snapshot.vehicle.rpm).toLocaleString()}</strong>
              </div>
              <div>
                <span>SPEED</span>
                <strong>{Math.round(snapshot.vehicle.speedKmh)}</strong>
              </div>
            </div>
            <div className="gear-display">{formatGear(snapshot.vehicle.gear)}</div>
            <div className="speed-caption">KM/H</div>
            <div className="rpm-sweep">
              <div
                className="rpm-sweep-fill"
                style={{ "--rpm-ratio": `${Math.max(0, Math.min(100, (rpm / Math.max(maxRpm, 1)) * 100))}%` } as CSSProperties}
              />
            </div>
            <div className="max-rpm-readout">
              <span>MAX RPM</span>
              <strong>{numberOrDash(maxRpm)}</strong>
            </div>
          </section>

          <div className="right-stack">
            <PowertrainPanel vehicle={snapshot.vehicle} />
            <MotionPanel motion={snapshot.motion} />
          </div>
        </section>
      )}
    </section>
  );
}

function DashboardApp() {
  const { snapshot, connectionStatus, renderHz } = useTelemetry();

  return (
    <main className="dashboard-stage">
      <Gt3Dashboard
        connectionStatus={connectionStatus}
        renderHz={renderHz}
        snapshot={snapshot}
      />
    </main>
  );
}

export function App() {
  if (window.location.pathname.startsWith("/settings")) {
    return <SettingsPage />;
  }

  return <DashboardApp />;
}
