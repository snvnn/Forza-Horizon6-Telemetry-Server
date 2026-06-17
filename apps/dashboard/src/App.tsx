import { SettingsPage } from "./settings/SettingsPage";
import { memo, type ReactNode } from "react";
import type {
  TelemetryClientMetrics,
  TelemetryConnectionStatus,
  TelemetrySnapshot
} from "./telemetry/telemetryTypes";
import { useTelemetry } from "./telemetry/useTelemetry";

const METERS_PER_SECOND_SQUARED_PER_G = 9.80665;
const DISPLAY_MAX_G = 2.5;
const SHIFT_LIGHT_COUNT = 36;
const SHIFT_LIGHT_INDEXES = Array.from({ length: SHIFT_LIGHT_COUNT }, (_, index) => index);
const STEER_CENTER_DEADZONE = 0.01;

type TirePosition = "front-left" | "front-right" | "rear-left" | "rear-right";
type TireTempTone = "unknown" | "cold" | "cool" | "optimal" | "warm" | "hot";

type RaceDashboardProps = {
  snapshot: TelemetrySnapshot | null;
  connectionStatus: TelemetryConnectionStatus;
  renderHz: number;
  clientMetrics: TelemetryClientMetrics;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatNumber(value: number | undefined, fractionDigits = 2): string {
  if (value == null || !Number.isFinite(value)) {
    return "--";
  }
  return value.toFixed(fractionDigits);
}

function formatInteger(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "--";
  }
  return String(Math.round(value));
}

function formatSpeedKmh(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "--";
  }
  return String(Math.max(0, Math.floor(value)));
}

function formatTemperatureC(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "--℃";
  }
  return `${value.toFixed(1)}℃`;
}

function tireTempTone(value: number | undefined): TireTempTone {
  if (value == null || !Number.isFinite(value)) {
    return "unknown";
  }
  // FH6 exposes temperatures but no official color thresholds, so these bands
  // make the normal 80-105℃ race operating window visually neutral.
  if (value < 60) {
    return "cold";
  }
  if (value < 80) {
    return "cool";
  }
  if (value <= 105) {
    return "optimal";
  }
  if (value <= 120) {
    return "warm";
  }
  return "hot";
}

function formatPercent(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "--";
  }
  return `${Math.round(clamp(value, 0, 1) * 100)}%`;
}

function formatConnection(status: TelemetryConnectionStatus, snapshot: TelemetrySnapshot | null): string {
  if (status === "connected" && snapshot?.connected) {
    return "LIVE";
  }
  if (snapshot && !snapshot.connected) {
    return "STALE";
  }
  return status.toUpperCase();
}

function gearLabel(gear: number | undefined): string {
  if (gear == null || !Number.isFinite(gear)) {
    return "-";
  }
  if (gear < -1 || gear > 10) {
    return "-";
  }
  if (gear === -1) {
    return "R";
  }
  if (gear === 0) {
    return "N";
  }
  return String(gear);
}

function hasPositiveValue(value: number | undefined): boolean {
  return value != null && Number.isFinite(value) && value > 0;
}

function shouldShowRaceInfo(snapshot: TelemetrySnapshot): boolean {
  const race = snapshot.race;
  const lapTimerRunning = hasPositiveValue(race?.currentLapSeconds) && hasPositiveValue(race?.currentRaceTimeSeconds);
  const completedLapContext = hasPositiveValue(race?.bestLapSeconds) || hasPositiveValue(race?.lastLapSeconds);

  // FH6 can report IsRaceOn during freeroam. Only switch the left panel from
  // inputs to race timing when race-only fields are also valid.
  return (
    race?.active === true &&
    hasPositiveValue(race.position) &&
    hasPositiveValue(race.lapNumber) &&
    (lapTimerRunning || completedLapContext)
  );
}

function getRpmRatio(snapshot: TelemetrySnapshot | null): number {
  if (!snapshot) {
    return 0;
  }
  const maxRpm = snapshot.vehicle.maxRpm && snapshot.vehicle.maxRpm > 0 ? snapshot.vehicle.maxRpm : 8500;
  return clamp(snapshot.vehicle.rpm / maxRpm, 0, 1);
}

function formatTime(timestamp: number | undefined): string {
  if (!timestamp || !Number.isFinite(timestamp)) {
    return "--";
  }
  return new Date(timestamp).toLocaleTimeString();
}

function formatMilliseconds(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "--";
  }
  return String(Math.max(0, Math.round(value)));
}

function formatHz(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "--";
  }
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}

function formatDuration(seconds: number | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) {
    return "--";
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds - minutes * 60;
  return `${minutes}:${remainingSeconds.toFixed(3).padStart(6, "0")}`;
}

function formatSignedDelta(seconds: number | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) {
    return "--";
  }

  const sign = seconds >= 0 ? "+" : "-";
  return `${sign}${formatDuration(Math.abs(seconds))}`;
}

const ShiftLights = memo(function ShiftLights({ rpmRatio }: { rpmRatio: number }) {
  const activeCount = Math.round(rpmRatio * SHIFT_LIGHT_COUNT);

  return (
    <div className="race-shift-rail" aria-label="RPM shift lights">
      {SHIFT_LIGHT_INDEXES.map((index) => {
        const active = index < activeCount;
        const band = index < 14 ? "green" : index < 24 ? "amber" : index < 31 ? "red" : "blue";
        return (
          <span
            className={`race-shift-dot race-shift-${band} ${active ? "race-shift-active" : ""}`}
            key={index}
          />
        );
      })}
    </div>
  );
});

function InputBar({
  label,
  value,
  tone
}: {
  label: string;
  value: number | undefined;
  tone: "green" | "red" | "yellow" | "cyan";
}) {
  const percent = clamp(value ?? 0, 0, 1) * 100;

  return (
    <div className="race-input-row">
      <span>{label}</span>
      <div className="race-input-track">
        <div className={`race-input-fill race-input-${tone}`} style={{ width: `${percent}%` }} />
      </div>
      <strong>{formatPercent(value)}</strong>
    </div>
  );
}

function SteerBar({ value }: { value: number | undefined }) {
  const normalized = clamp(value ?? 0, -1, 1);
  const visualNormalized = Math.abs(normalized) < STEER_CENTER_DEADZONE ? 0 : normalized;
  const dotLeft = ((visualNormalized + 1) / 2) * 100;

  return (
    <div className="race-input-row">
      <span>Steer</span>
      <div className="race-steer-track">
        <div className="race-steer-zero" />
        <div className="race-steer-dot" style={{ left: `${dotLeft}%` }} />
      </div>
      <strong>{Math.round(visualNormalized * 100)}%</strong>
    </div>
  );
}

function MetricBox({
  label,
  value,
  unit,
  accent
}: {
  label: string;
  value: string;
  unit?: string;
  accent?: "red" | "yellow" | "cyan" | "green";
}) {
  return (
    <div className={`race-metric ${accent ? `race-metric-${accent}` : ""}`}>
      <span>{label}</span>
      <strong>
        {value}
        {unit ? <em>{unit}</em> : null}
      </strong>
    </div>
  );
}

function Panel({
  title,
  children,
  className
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`race-panel ${className ?? ""}`}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function TireMapCorner({
  position,
  value
}: {
  position: TirePosition;
  value: number | undefined;
}) {
  const tone = tireTempTone(value);

  return (
    <div className={`race-tire-corner race-tire-${position}`}>
      <strong className="race-tire-temperature">{formatTemperatureC(value)}</strong>
      <span
        aria-label={`${position} tire temperature ${formatTemperatureC(value)}`}
        className={`race-tire-shape race-tire-temp-${tone}`}
      />
    </div>
  );
}

const PowertrainPanel = memo(function PowertrainPanel({ snapshot }: { snapshot: TelemetrySnapshot }) {
  return (
    <Panel className="race-powertrain-panel" title="Powertrain">
      <div className="race-power-grid">
        <MetricBox accent="yellow" label="Power" unit="kW" value={formatInteger(snapshot.vehicle.powerKw)} />
        <MetricBox accent="red" label="Torque" unit="Nm" value={formatInteger(snapshot.vehicle.torqueNm)} />
        <MetricBox accent="cyan" label="Boost" value={formatNumber(snapshot.vehicle.boost, 2)} />
      </div>
    </Panel>
  );
});

const InputsPanel = memo(function InputsPanel({ snapshot }: { snapshot: TelemetrySnapshot }) {
  return (
    <Panel className="race-inputs-panel" title="Inputs">
      <div className="race-inputs">
        <InputBar label="Throttle" tone="green" value={snapshot.input.throttle} />
        <InputBar label="Brake" tone="red" value={snapshot.input.brake} />
        <SteerBar value={snapshot.input.steer} />
        <InputBar label="Clutch" tone="yellow" value={snapshot.input.clutch} />
        <InputBar label="Handbrake" tone="cyan" value={snapshot.input.handbrake} />
      </div>
    </Panel>
  );
});

const RaceInfoPanel = memo(function RaceInfoPanel({ snapshot }: { snapshot: TelemetrySnapshot }) {
  const race = snapshot.race;
  const lapDelta =
    race?.currentLapSeconds != null && race.bestLapSeconds != null
      ? race.currentLapSeconds - race.bestLapSeconds
      : undefined;

  return (
    <Panel className="race-race-info-panel" title="Race Info">
      <div className="race-info-grid">
        <MetricBox accent="yellow" label="Position" value={formatInteger(race?.position)} />
        <MetricBox accent="cyan" label="Lap Done" value={formatInteger(race?.lapNumber)} />
        <MetricBox label="Current" value={formatDuration(race?.currentLapSeconds)} />
        <MetricBox label="Best" value={formatDuration(race?.bestLapSeconds)} />
        <MetricBox label="Last" value={formatDuration(race?.lastLapSeconds)} />
        <MetricBox accent={lapDelta != null && lapDelta <= 0 ? "green" : "red"} label="Delta" value={formatSignedDelta(lapDelta)} />
        <MetricBox label="Race Time" value={formatDuration(race?.currentRaceTimeSeconds)} />
        <MetricBox label="Fuel" value={formatPercent(race?.fuel)} />
      </div>
    </Panel>
  );
});

const TireTempsPanel = memo(function TireTempsPanel({ snapshot }: { snapshot: TelemetrySnapshot }) {
  const tires = snapshot.tires;

  return (
    <Panel className="race-tire-panel" title="Tire Temps">
      <div className="race-tire-map">
        <TireMapCorner position="front-left" value={tires?.frontLeftTemp} />
        <TireMapCorner position="front-right" value={tires?.frontRightTemp} />
        <TireMapCorner position="rear-left" value={tires?.rearLeftTemp} />
        <TireMapCorner position="rear-right" value={tires?.rearRightTemp} />
      </div>
    </Panel>
  );
});

const GForcePanel = memo(function GForcePanel({ snapshot }: { snapshot: TelemetrySnapshot }) {
  const accelX = snapshot.motion?.accelX ?? 0;
  const accelY = snapshot.motion?.accelY ?? 0;
  const accelZ = snapshot.motion?.accelZ ?? 0;
  // FH6 AccelerationX reports vehicle acceleration direction. Load transfer is
  // felt in the opposite lateral direction, so invert X for the marker.
  const lateralG = -accelX / METERS_PER_SECOND_SQUARED_PER_G;
  const longitudinalG = accelZ / METERS_PER_SECOND_SQUARED_PER_G;
  const totalG = Math.hypot(lateralG, longitudinalG);
  const markerX = 150 + clamp(lateralG / DISPLAY_MAX_G, -1, 1) * 108;
  const markerY = 150 + clamp(longitudinalG / DISPLAY_MAX_G, -1, 1) * 108;

  return (
    <Panel className="race-gforce-panel" title="G-Force">
      <div className="race-gforce">
        <div className="race-gforce-meter">
          <svg viewBox="0 0 300 300" role="img" aria-label="G-force load transfer">
            <circle className="race-g-ring race-g-ring-outer" cx="150" cy="150" r="124" />
            <circle className="race-g-ring" cx="150" cy="150" r="93" />
            <circle className="race-g-ring" cx="150" cy="150" r="62" />
            <circle className="race-g-ring" cx="150" cy="150" r="31" />
            <line className="race-g-axis" x1="26" x2="274" y1="150" y2="150" />
            <line className="race-g-axis" x1="150" x2="150" y1="26" y2="274" />
            <circle className="race-g-dot" cx={markerX} cy={markerY} r="10" />
          </svg>
        </div>
        <div className="race-gforce-values">
          <MetricBox accent="yellow" label="Total" unit="G" value={formatNumber(totalG, 2)} />
          <MetricBox accent="cyan" label="Lat" unit="G" value={formatNumber(lateralG, 2)} />
          <MetricBox accent="red" label="Long" unit="G" value={formatNumber(longitudinalG, 2)} />
        </div>
        <div className="race-motion-row">
          <div className="race-motion-cell">
            <span>X</span>
            <strong>{formatNumber(accelX, 2)}</strong>
          </div>
          <div className="race-motion-cell">
            <span>Y</span>
            <strong>{formatNumber(accelY, 2)}</strong>
          </div>
          <div className="race-motion-cell">
            <span>Z</span>
            <strong>{formatNumber(accelZ, 2)}</strong>
          </div>
        </div>
      </div>
    </Panel>
  );
});

const CenterCluster = memo(function CenterCluster({ snapshot }: { snapshot: TelemetrySnapshot }) {
  return (
    <section className="race-center-cluster">
      <div className="race-center-main">
        <div className="race-gear-block">
          <span>Gear</span>
          <strong>{gearLabel(snapshot.vehicle.gear)}</strong>
        </div>
        <div className="race-speed-block">
          <span>Speed</span>
          <strong>{formatSpeedKmh(snapshot.vehicle.speedKmh)}</strong>
          <em>km/h</em>
        </div>
      </div>
      <div className="race-rpm-number">
        <span className="race-rpm-label">RPM</span>
        <strong className="race-rpm-value">{formatInteger(snapshot.vehicle.rpm)}</strong>
        <span className="race-rpm-mobile">RPM {formatInteger(snapshot.vehicle.rpm)}</span>
      </div>
    </section>
  );
});

function WaitingDashboard({
  connectionStatus,
  renderHz,
  clientMetrics
}: Pick<RaceDashboardProps, "connectionStatus" | "renderHz" | "clientMetrics">) {
  return (
    <section className="race-dashboard race-dashboard-waiting">
      <header className="race-header">
        <div>
          <p className="race-kicker">SIM TELEMETRY</p>
          <h1>RACE DASHBOARD</h1>
        </div>
        <div className="race-header-metrics">
          <MetricBox label="Link" value={connectionStatus.toUpperCase()} />
          <MetricBox label="RX" unit="Hz" value={formatHz(clientMetrics.estimatedMessageHz)} />
        </div>
      </header>
      <ShiftLights rpmRatio={0} />
      <section className="race-waiting-message">Waiting for telemetry...</section>
    </section>
  );
}

function RaceTelemetryDashboard({
  snapshot,
  connectionStatus,
  renderHz,
  clientMetrics
}: RaceDashboardProps) {
  const rpmRatio = getRpmRatio(snapshot);

  if (!snapshot) {
    return (
      <WaitingDashboard
        clientMetrics={clientMetrics}
        connectionStatus={connectionStatus}
        renderHz={renderHz}
      />
    );
  }

  const showRaceInfo = shouldShowRaceInfo(snapshot);

  return (
    <section
      className={`race-dashboard ${snapshot.connected ? "race-live" : "race-stale"} ${
        showRaceInfo ? "race-mode" : "drive-mode"
      }`}
    >
      <header className="race-header">
        <div>
          <p className="race-kicker">FORZA HORIZON 6</p>
          <h1>RACE TELEMETRY</h1>
        </div>
        <div className="race-header-metrics">
          <MetricBox
            accent={connectionStatus === "connected" && snapshot.connected ? "green" : "red"}
            label="Link"
            value={formatConnection(connectionStatus, snapshot)}
          />
          <MetricBox accent="cyan" label="RX" unit="Hz" value={formatHz(clientMetrics.estimatedMessageHz)} />
          <MetricBox accent="yellow" label="Age" unit="ms" value={formatMilliseconds(clientMetrics.renderSnapshotAgeMs)} />
          <MetricBox label="UI" unit="ms" value={formatMilliseconds(clientMetrics.receiveToRenderMs)} />
        </div>
      </header>
      <ShiftLights rpmRatio={rpmRatio} />
      <div className="race-layout">
        <aside className="race-column">
          {showRaceInfo ? <RaceInfoPanel snapshot={snapshot} /> : <InputsPanel snapshot={snapshot} />}
          <TireTempsPanel snapshot={snapshot} />
        </aside>
        <CenterCluster snapshot={snapshot} />
        <aside className="race-column">
          <GForcePanel snapshot={snapshot} />
          <PowertrainPanel snapshot={snapshot} />
        </aside>
      </div>
    </section>
  );
}

function DashboardApp() {
  const { snapshot, clientMetrics, connectionStatus, renderHz } = useTelemetry();

  return (
    <main className="dashboard-stage race-stage">
      <RaceTelemetryDashboard
        connectionStatus={connectionStatus}
        clientMetrics={clientMetrics}
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
