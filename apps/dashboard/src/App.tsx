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

type DashboardLayout = "race" | "time-attack" | "engineer" | "mobile-race" | "minimal" | "gforce";

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

function validNumberInRange(value: number | undefined, min: number, max: number): number | undefined {
  if (value == null || !Number.isFinite(value) || value < min || value > max) {
    return undefined;
  }
  return value;
}

function validRacePosition(value: number | undefined): number | undefined {
  return validNumberInRange(value, 1, 999);
}

function validLapNumber(value: number | undefined): number | undefined {
  return validNumberInRange(value, 1, 999);
}

function validRaceSeconds(value: number | undefined): number | undefined {
  return validNumberInRange(value, 0.001, 24 * 60 * 60);
}

function validRaceDistanceMeters(value: number | undefined): number | undefined {
  return validNumberInRange(value, 0, 1_000_000);
}

function shouldShowRaceInfo(snapshot: TelemetrySnapshot): boolean {
  const race = snapshot.race;
  const lapTimerRunning =
    validRaceSeconds(race?.currentLapSeconds) != null && validRaceSeconds(race?.currentRaceTimeSeconds) != null;
  const completedLapContext = validRaceSeconds(race?.bestLapSeconds) != null || validRaceSeconds(race?.lastLapSeconds) != null;

  // FH6 can report IsRaceOn during freeroam. Only switch the left panel from
  // inputs to race timing when race-only fields are also valid.
  return (
    race?.active === true &&
    validRacePosition(race.position) != null &&
    validLapNumber(race.lapNumber) != null &&
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

function formatSignedNumber(value: number | undefined, fractionDigits = 2): string {
  if (value == null || !Number.isFinite(value)) {
    return "--";
  }

  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(fractionDigits)}`;
}

function formatBoolean(value: boolean | undefined): string {
  if (value == null) {
    return "--";
  }
  return value ? "TRUE" : "FALSE";
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

function normalizeDashboardLayout(layout: string | null | undefined): DashboardLayout | null {
  if (!layout) {
    return null;
  }

  const normalized = layout.trim().toLowerCase();

  if (normalized === "time-attack" || normalized === "timeattack") {
    return "time-attack";
  }

  if (normalized === "engineer" || normalized === "telemetry" || normalized === "telemetry-engineer") {
    return "engineer";
  }

  if (normalized === "mobile" || normalized === "mobile-race" || normalized === "landscape-race") {
    return "mobile-race";
  }

  if (normalized === "minimal" || normalized === "minimal-hud" || normalized === "hud") {
    return "minimal";
  }

  if (normalized === "gforce" || normalized === "g-force" || normalized === "gforce-focus") {
    return "gforce";
  }

  if (normalized === "race" || normalized === "gt" || normalized === "gt3") {
    return "race";
  }

  return null;
}

function selectedDashboardLayout(configuredLayout: string | null | undefined): DashboardLayout {
  const params = new URLSearchParams(window.location.search);
  const urlLayout = normalizeDashboardLayout(params.get("layout") ?? params.get("dashboard"));
  const configLayout = normalizeDashboardLayout(configuredLayout);

  return urlLayout ?? configLayout ?? "race";
}

function dashboardStageClass(layout: DashboardLayout): string {
  switch (layout) {
    case "time-attack":
      return "time-attack-stage";
    case "engineer":
      return "engineer-stage";
    case "mobile-race":
      return "mobile-race-stage";
    case "minimal":
      return "minimal-stage";
    case "gforce":
      return "gfocus-stage";
    case "race":
    default:
      return "";
  }
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

function TimeAttackMetric({
  label,
  value,
  unit,
  tone
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: "green" | "red" | "yellow" | "cyan";
}) {
  return (
    <div className={`ta-metric ${tone ? `ta-metric-${tone}` : ""}`}>
      <span>{label}</span>
      <strong>
        {value}
        {unit ? <em>{unit}</em> : null}
      </strong>
    </div>
  );
}

function TimeAttackGForce({ snapshot }: { snapshot: TelemetrySnapshot }) {
  const accelX = snapshot.motion?.accelX ?? 0;
  const accelZ = snapshot.motion?.accelZ ?? 0;
  const lateralG = -accelX / METERS_PER_SECOND_SQUARED_PER_G;
  const longitudinalG = accelZ / METERS_PER_SECOND_SQUARED_PER_G;
  const totalG = Math.hypot(lateralG, longitudinalG);
  const markerX = 150 + clamp(lateralG / DISPLAY_MAX_G, -1, 1) * 108;
  const markerY = 150 + clamp(longitudinalG / DISPLAY_MAX_G, -1, 1) * 108;

  return (
    <div className="ta-gforce">
      <svg viewBox="0 0 300 300" role="img" aria-label="G-force load transfer">
        <circle className="race-g-ring race-g-ring-outer" cx="150" cy="150" r="124" />
        <circle className="race-g-ring" cx="150" cy="150" r="93" />
        <circle className="race-g-ring" cx="150" cy="150" r="62" />
        <circle className="race-g-ring" cx="150" cy="150" r="31" />
        <line className="race-g-axis" x1="26" x2="274" y1="150" y2="150" />
        <line className="race-g-axis" x1="150" x2="150" y1="26" y2="274" />
        <circle className="race-g-dot" cx={markerX} cy={markerY} r="10" />
      </svg>
      <div className="ta-gforce-values">
        <TimeAttackMetric label="Total" unit="G" value={formatNumber(totalG, 2)} />
        <TimeAttackMetric label="Lat" unit="G" value={formatNumber(lateralG, 2)} />
        <TimeAttackMetric label="Long" unit="G" value={formatNumber(longitudinalG, 2)} />
      </div>
    </div>
  );
}

function TimeAttackDashboard({
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

  const race = snapshot.race;
  const showRaceInfo = shouldShowRaceInfo(snapshot);
  const currentLapSeconds = showRaceInfo ? validRaceSeconds(race?.currentLapSeconds) : undefined;
  const bestLapSeconds = showRaceInfo ? validRaceSeconds(race?.bestLapSeconds) : undefined;
  const lastLapSeconds = showRaceInfo ? validRaceSeconds(race?.lastLapSeconds) : undefined;
  const currentRaceTimeSeconds = showRaceInfo ? validRaceSeconds(race?.currentRaceTimeSeconds) : undefined;
  const lapDelta =
    currentLapSeconds != null && bestLapSeconds != null
      ? currentLapSeconds - bestLapSeconds
      : undefined;
  const deltaTone = lapDelta == null ? "yellow" : lapDelta <= 0 ? "green" : "red";

  return (
    <section
      className={`race-dashboard time-attack-dashboard ${snapshot.connected ? "race-live" : "race-stale"} ${
        showRaceInfo ? "ta-timed" : "ta-no-timing"
      }`}
    >
      <header className="race-header ta-header">
        <div>
          <p className="race-kicker">FORZA HORIZON 6</p>
          <h1>TIME ATTACK</h1>
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
      <div className="ta-layout">
        <section className="ta-main">
          <div className="ta-status-line">
            <span>{showRaceInfo ? "TIMED RUN" : "NO TIMED LAP"}</span>
            <strong>{formatTime(snapshot.timestamp)}</strong>
          </div>
          <div className={`ta-delta ta-delta-${deltaTone}`}>
            <span>Delta</span>
            <strong>{formatSignedDelta(lapDelta)}</strong>
          </div>
          <div className="ta-current-lap">
            <span>Current Lap</span>
            <strong>{formatDuration(currentLapSeconds)}</strong>
          </div>
          <div className="ta-lap-row">
            <TimeAttackMetric label="Best" tone="green" value={formatDuration(bestLapSeconds)} />
            <TimeAttackMetric label="Last" tone="yellow" value={formatDuration(lastLapSeconds)} />
            <TimeAttackMetric label="Race Time" value={formatDuration(currentRaceTimeSeconds)} />
          </div>
          <div className="ta-car-strip">
            <div className="ta-gear">
              <span>Gear</span>
              <strong>{gearLabel(snapshot.vehicle.gear)}</strong>
            </div>
            <div className="ta-speed">
              <span>Speed</span>
              <strong>{formatSpeedKmh(snapshot.vehicle.speedKmh)}</strong>
              <em>km/h</em>
            </div>
            <div className="ta-rpm">
              <span>RPM</span>
              <strong>{formatInteger(snapshot.vehicle.rpm)}</strong>
            </div>
          </div>
        </section>

        <aside className="ta-side">
          <section className="ta-panel">
            <h2>Run</h2>
            <div className="ta-grid">
              <TimeAttackMetric label="Position" tone="yellow" value={formatInteger(showRaceInfo ? validRacePosition(race?.position) : undefined)} />
              <TimeAttackMetric label="Lap" tone="cyan" value={formatInteger(showRaceInfo ? validLapNumber(race?.lapNumber) : undefined)} />
              <TimeAttackMetric label="Fuel" value={showRaceInfo ? formatPercent(race?.fuel) : "--"} />
              <TimeAttackMetric label="Distance" unit="m" value={formatInteger(showRaceInfo ? validRaceDistanceMeters(race?.distanceTraveledMeters) : undefined)} />
            </div>
          </section>
          <section className="ta-panel">
            <h2>Inputs</h2>
            <div className="race-inputs">
              <InputBar label="Throttle" tone="green" value={snapshot.input.throttle} />
              <InputBar label="Brake" tone="red" value={snapshot.input.brake} />
              <SteerBar value={snapshot.input.steer} />
            </div>
          </section>
          <section className="ta-panel ta-compact-g">
            <h2>G-Force</h2>
            <TimeAttackGForce snapshot={snapshot} />
          </section>
        </aside>
      </div>
    </section>
  );
}

function EngineerCell({
  label,
  value,
  unit,
  tone
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: "green" | "red" | "yellow" | "cyan";
}) {
  return (
    <div className={`eng-cell ${tone ? `eng-cell-${tone}` : ""}`}>
      <span>{label}</span>
      <strong>
        {value}
        {unit ? <em>{unit}</em> : null}
      </strong>
    </div>
  );
}

function EngineerSection({
  title,
  children,
  className
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`eng-section ${className ?? ""}`}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function TelemetryEngineerDashboard({
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

  const race = snapshot.race;
  const validRace = shouldShowRaceInfo(snapshot);
  const accelX = snapshot.motion?.accelX;
  const accelY = snapshot.motion?.accelY;
  const accelZ = snapshot.motion?.accelZ;
  const lateralG = accelX == null ? undefined : -accelX / METERS_PER_SECOND_SQUARED_PER_G;
  const longitudinalG = accelZ == null ? undefined : accelZ / METERS_PER_SECOND_SQUARED_PER_G;
  const totalG =
    lateralG == null || longitudinalG == null ? undefined : Math.hypot(lateralG, longitudinalG);

  return (
    <section className={`race-dashboard engineer-dashboard ${snapshot.connected ? "race-live" : "race-stale"}`}>
      <header className="race-header engineer-header">
        <div>
          <p className="race-kicker">NORMALIZED DATA</p>
          <h1>TELEMETRY ENGINEER</h1>
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
      <div className="eng-layout">
        <EngineerSection className="eng-runtime" title="Runtime">
          <div className="eng-grid eng-grid-2">
            <EngineerCell
              label="Game Link"
              tone={snapshot.connected ? "green" : "red"}
              value={snapshot.connected ? "CONNECTED" : "STALE"}
            />
            <EngineerCell label="Updated" value={formatTime(snapshot.timestamp)} />
            <EngineerCell label="Messages" value={formatInteger(clientMetrics.receivedMessages)} />
            <EngineerCell label="Parse Errors" tone={clientMetrics.parseErrors > 0 ? "red" : "green"} value={formatInteger(clientMetrics.parseErrors)} />
            <EngineerCell label="RX EMA" unit="ms" value={formatMilliseconds(clientMetrics.messageIntervalEmaMs)} />
            <EngineerCell label="Max Gap" unit="ms" value={formatMilliseconds(clientMetrics.maxMessageGapMs)} />
          </div>
        </EngineerSection>

        <EngineerSection className="eng-vehicle" title="Vehicle">
          <div className="eng-grid eng-grid-3">
            <EngineerCell label="Speed" unit="km/h" tone="cyan" value={formatSpeedKmh(snapshot.vehicle.speedKmh)} />
            <EngineerCell label="Gear" tone="yellow" value={gearLabel(snapshot.vehicle.gear)} />
            <EngineerCell label="RPM" value={formatInteger(snapshot.vehicle.rpm)} />
            <EngineerCell label="Max RPM" value={formatInteger(snapshot.vehicle.maxRpm)} />
            <EngineerCell label="Power" unit="kW" value={formatInteger(snapshot.vehicle.powerKw)} />
            <EngineerCell label="Torque" unit="Nm" value={formatInteger(snapshot.vehicle.torqueNm)} />
            <EngineerCell label="Boost" value={formatNumber(snapshot.vehicle.boost, 2)} />
            <EngineerCell label="RPM Ratio" value={formatPercent(rpmRatio)} />
            <EngineerCell label="Frame Age" unit="ms" value={formatMilliseconds(clientMetrics.renderSnapshotAgeMs)} />
          </div>
        </EngineerSection>

        <EngineerSection className="eng-inputs" title="Driver Inputs">
          <div className="eng-bars">
            <InputBar label="Throttle" tone="green" value={snapshot.input.throttle} />
            <InputBar label="Brake" tone="red" value={snapshot.input.brake} />
            <InputBar label="Clutch" tone="yellow" value={snapshot.input.clutch} />
            <InputBar label="Handbrake" tone="cyan" value={snapshot.input.handbrake} />
            <SteerBar value={snapshot.input.steer} />
          </div>
        </EngineerSection>

        <EngineerSection className="eng-tires" title="Tires">
          <div className="eng-tire-table">
            <EngineerCell label="Front Left" value={formatTemperatureC(snapshot.tires?.frontLeftTemp)} />
            <EngineerCell label="Front Right" value={formatTemperatureC(snapshot.tires?.frontRightTemp)} />
            <EngineerCell label="Rear Left" value={formatTemperatureC(snapshot.tires?.rearLeftTemp)} />
            <EngineerCell label="Rear Right" value={formatTemperatureC(snapshot.tires?.rearRightTemp)} />
          </div>
        </EngineerSection>

        <EngineerSection className="eng-motion" title="Motion">
          <div className="eng-grid eng-grid-3">
            <EngineerCell label="Accel X" value={formatSignedNumber(accelX, 2)} />
            <EngineerCell label="Accel Y" value={formatSignedNumber(accelY, 2)} />
            <EngineerCell label="Accel Z" value={formatSignedNumber(accelZ, 2)} />
            <EngineerCell label="Lat G" unit="G" tone="cyan" value={formatSignedNumber(lateralG, 2)} />
            <EngineerCell label="Long G" unit="G" tone="yellow" value={formatSignedNumber(longitudinalG, 2)} />
            <EngineerCell label="Total G" unit="G" value={formatNumber(totalG, 2)} />
          </div>
        </EngineerSection>

        <EngineerSection className="eng-race" title="Race Context">
          <div className="eng-grid eng-grid-2">
            <EngineerCell label="Packet Race Flag" tone={race?.active ? "green" : undefined} value={formatBoolean(race?.active)} />
            <EngineerCell label="Validated" tone={validRace ? "green" : "yellow"} value={validRace ? "TRUE" : "FALSE"} />
            <EngineerCell label="Position" value={formatInteger(validRace ? validRacePosition(race?.position) : undefined)} />
            <EngineerCell label="Lap" value={formatInteger(validRace ? validLapNumber(race?.lapNumber) : undefined)} />
            <EngineerCell label="Current Lap" value={formatDuration(validRace ? validRaceSeconds(race?.currentLapSeconds) : undefined)} />
            <EngineerCell label="Best Lap" value={formatDuration(validRace ? validRaceSeconds(race?.bestLapSeconds) : undefined)} />
            <EngineerCell label="Last Lap" value={formatDuration(validRace ? validRaceSeconds(race?.lastLapSeconds) : undefined)} />
            <EngineerCell label="Fuel" value={validRace ? formatPercent(race?.fuel) : "--"} />
          </div>
        </EngineerSection>
      </div>
    </section>
  );
}

function MobileRaceStat({
  label,
  value,
  unit,
  tone
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: "green" | "red" | "yellow" | "cyan";
}) {
  return (
    <div className={`mobile-race-stat ${tone ? `mobile-race-stat-${tone}` : ""}`}>
      <span>{label}</span>
      <strong>
        {value}
        {unit ? <em>{unit}</em> : null}
      </strong>
    </div>
  );
}

function MobileRaceTire({
  label,
  value
}: {
  label: string;
  value: number | undefined;
}) {
  const tone = tireTempTone(value);

  return (
    <div className="mobile-race-tire-cell">
      <span>{label}</span>
      <strong>{formatTemperatureC(value)}</strong>
      <i className={`mobile-race-tire-shape race-tire-temp-${tone}`} />
    </div>
  );
}

function MobileRaceGForce({ snapshot }: { snapshot: TelemetrySnapshot }) {
  const accelX = snapshot.motion?.accelX ?? 0;
  const accelZ = snapshot.motion?.accelZ ?? 0;
  const lateralG = -accelX / METERS_PER_SECOND_SQUARED_PER_G;
  const longitudinalG = accelZ / METERS_PER_SECOND_SQUARED_PER_G;
  const totalG = Math.hypot(lateralG, longitudinalG);
  const markerX = 150 + clamp(lateralG / DISPLAY_MAX_G, -1, 1) * 108;
  const markerY = 150 + clamp(longitudinalG / DISPLAY_MAX_G, -1, 1) * 108;

  return (
    <div className="mobile-race-gforce">
      <svg viewBox="0 0 300 300" role="img" aria-label="G-force load transfer">
        <circle className="race-g-ring race-g-ring-outer" cx="150" cy="150" r="124" />
        <circle className="race-g-ring" cx="150" cy="150" r="93" />
        <circle className="race-g-ring" cx="150" cy="150" r="62" />
        <circle className="race-g-ring" cx="150" cy="150" r="31" />
        <line className="race-g-axis" x1="26" x2="274" y1="150" y2="150" />
        <line className="race-g-axis" x1="150" x2="150" y1="26" y2="274" />
        <circle className="race-g-dot" cx={markerX} cy={markerY} r="10" />
      </svg>
      <div className="mobile-race-gforce-readouts">
        <MobileRaceStat label="Total" unit="G" value={formatNumber(totalG, 2)} />
        <MobileRaceStat label="Lat" unit="G" value={formatSignedNumber(lateralG, 2)} />
        <MobileRaceStat label="Long" unit="G" value={formatSignedNumber(longitudinalG, 2)} />
      </div>
    </div>
  );
}

function MobileRaceDashboard({
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

  const race = snapshot.race;
  const showRaceInfo = shouldShowRaceInfo(snapshot);
  const lapDelta =
    showRaceInfo && race?.currentLapSeconds != null && race.bestLapSeconds != null
      ? race.currentLapSeconds - race.bestLapSeconds
      : undefined;

  return (
    <section className={`race-dashboard mobile-race-dashboard ${snapshot.connected ? "race-live" : "race-stale"}`}>
      <header className="mobile-race-topbar">
        <div className="mobile-race-title">
          <span>FH6</span>
          <strong>RACE HUD</strong>
        </div>
        <div className="mobile-race-status">
          <MobileRaceStat
            label="Link"
            tone={connectionStatus === "connected" && snapshot.connected ? "green" : "red"}
            value={formatConnection(connectionStatus, snapshot)}
          />
          <MobileRaceStat label="RX" unit="Hz" tone="cyan" value={formatHz(clientMetrics.estimatedMessageHz)} />
          <MobileRaceStat label="Age" unit="ms" tone="yellow" value={formatMilliseconds(clientMetrics.renderSnapshotAgeMs)} />
        </div>
      </header>
      <ShiftLights rpmRatio={rpmRatio} />
      <div className="mobile-race-layout">
        <aside className="mobile-race-left">
          {showRaceInfo ? (
            <section className="mobile-race-panel">
              <h2>Race</h2>
              <div className="mobile-race-grid">
                <MobileRaceStat label="Pos" tone="yellow" value={formatInteger(validRacePosition(race?.position))} />
                <MobileRaceStat label="Lap" tone="cyan" value={formatInteger(validLapNumber(race?.lapNumber))} />
                <MobileRaceStat label="Current" value={formatDuration(validRaceSeconds(race?.currentLapSeconds))} />
                <MobileRaceStat label="Delta" tone={lapDelta != null && lapDelta <= 0 ? "green" : "red"} value={formatSignedDelta(lapDelta)} />
              </div>
            </section>
          ) : (
            <section className="mobile-race-panel">
              <h2>Tires</h2>
              <div className="mobile-race-tires">
                <MobileRaceTire label="FL" value={snapshot.tires?.frontLeftTemp} />
                <MobileRaceTire label="FR" value={snapshot.tires?.frontRightTemp} />
                <MobileRaceTire label="RL" value={snapshot.tires?.rearLeftTemp} />
                <MobileRaceTire label="RR" value={snapshot.tires?.rearRightTemp} />
              </div>
            </section>
          )}
          <section className="mobile-race-panel mobile-race-input-panel">
            <h2>Inputs</h2>
            <InputBar label="Thr" tone="green" value={snapshot.input.throttle} />
            <InputBar label="Brk" tone="red" value={snapshot.input.brake} />
            <SteerBar value={snapshot.input.steer} />
          </section>
        </aside>

        <section className="mobile-race-center">
          <div className="mobile-race-gear">
            <span>Gear</span>
            <strong>{gearLabel(snapshot.vehicle.gear)}</strong>
          </div>
          <div className="mobile-race-speed">
            <span>Speed</span>
            <strong>{formatSpeedKmh(snapshot.vehicle.speedKmh)}</strong>
            <em>km/h</em>
          </div>
          <div className="mobile-race-rpm">
            <span>RPM</span>
            <strong>{formatInteger(snapshot.vehicle.rpm)}</strong>
          </div>
        </section>

        <aside className="mobile-race-right">
          <section className="mobile-race-panel mobile-race-g-panel">
            <h2>G-Force</h2>
            <MobileRaceGForce snapshot={snapshot} />
          </section>
          <section className="mobile-race-panel mobile-race-power">
            <MobileRaceStat label="Power" unit="kW" tone="yellow" value={formatInteger(snapshot.vehicle.powerKw)} />
            <MobileRaceStat label="Torque" unit="Nm" tone="red" value={formatInteger(snapshot.vehicle.torqueNm)} />
            <MobileRaceStat label="Boost" tone="cyan" value={formatNumber(snapshot.vehicle.boost, 2)} />
          </section>
        </aside>
      </div>
    </section>
  );
}

function MinimalHudStat({
  label,
  value,
  unit,
  tone
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: "green" | "red" | "yellow" | "cyan";
}) {
  return (
    <div className={`minimal-stat ${tone ? `minimal-stat-${tone}` : ""}`}>
      <span>{label}</span>
      <strong>
        {value}
        {unit ? <em>{unit}</em> : null}
      </strong>
    </div>
  );
}

function MinimalHudDashboard({
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

  const tires = [
    snapshot.tires?.frontLeftTemp,
    snapshot.tires?.frontRightTemp,
    snapshot.tires?.rearLeftTemp,
    snapshot.tires?.rearRightTemp
  ];
  const validTires = tires.filter((value): value is number => value != null && Number.isFinite(value));
  const hottestTire = validTires.length > 0 ? Math.max(...validTires) : undefined;
  const coldestTire = validTires.length > 0 ? Math.min(...validTires) : undefined;
  const tireTone = hottestTire != null && hottestTire > 120 ? "red" : coldestTire != null && coldestTire < 60 ? "cyan" : "green";
  const accelX = snapshot.motion?.accelX ?? 0;
  const accelZ = snapshot.motion?.accelZ ?? 0;
  const lateralG = -accelX / METERS_PER_SECOND_SQUARED_PER_G;
  const longitudinalG = accelZ / METERS_PER_SECOND_SQUARED_PER_G;
  const totalG = Math.hypot(lateralG, longitudinalG);

  return (
    <section className={`race-dashboard minimal-dashboard ${snapshot.connected ? "race-live" : "race-stale"}`}>
      <header className="minimal-topbar">
        <div className="minimal-brand">
          <span>FH6</span>
          <strong>MINIMAL HUD</strong>
        </div>
        <div className="minimal-status">
          <MinimalHudStat
            label="Link"
            tone={connectionStatus === "connected" && snapshot.connected ? "green" : "red"}
            value={formatConnection(connectionStatus, snapshot)}
          />
          <MinimalHudStat label="RX" unit="Hz" tone="cyan" value={formatHz(clientMetrics.estimatedMessageHz)} />
          <MinimalHudStat label="Age" unit="ms" tone="yellow" value={formatMilliseconds(clientMetrics.renderSnapshotAgeMs)} />
        </div>
      </header>
      <ShiftLights rpmRatio={rpmRatio} />
      <main className="minimal-main">
        <section className="minimal-gear">
          <span>Gear</span>
          <strong>{gearLabel(snapshot.vehicle.gear)}</strong>
        </section>
        <section className="minimal-speed">
          <span>Speed</span>
          <strong>{formatSpeedKmh(snapshot.vehicle.speedKmh)}</strong>
          <em>km/h</em>
        </section>
        <section className="minimal-rpm">
          <span>RPM</span>
          <strong>{formatInteger(snapshot.vehicle.rpm)}</strong>
        </section>
      </main>
      <footer className="minimal-footer">
        <MinimalHudStat label="Throttle" value={formatPercent(snapshot.input.throttle)} tone="green" />
        <MinimalHudStat label="Brake" value={formatPercent(snapshot.input.brake)} tone="red" />
        <MinimalHudStat label="Steer" value={`${Math.round(clamp(snapshot.input.steer ?? 0, -1, 1) * 100)}%`} tone="cyan" />
        <MinimalHudStat label="G" unit="G" value={formatNumber(totalG, 2)} />
        <MinimalHudStat label="Lat" unit="G" value={formatSignedNumber(lateralG, 2)} tone="yellow" />
        <MinimalHudStat label="Tire" value={formatTemperatureC(hottestTire)} tone={tireTone} />
      </footer>
    </section>
  );
}

function GForceFocusStat({
  label,
  value,
  unit,
  tone
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: "green" | "red" | "yellow" | "cyan";
}) {
  return (
    <div className={`gfocus-stat ${tone ? `gfocus-stat-${tone}` : ""}`}>
      <span>{label}</span>
      <strong>
        {value}
        {unit ? <em>{unit}</em> : null}
      </strong>
    </div>
  );
}

function GForceFocusDashboard({
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

  const accelX = snapshot.motion?.accelX ?? 0;
  const accelY = snapshot.motion?.accelY ?? 0;
  const accelZ = snapshot.motion?.accelZ ?? 0;
  const lateralG = -accelX / METERS_PER_SECOND_SQUARED_PER_G;
  const longitudinalG = accelZ / METERS_PER_SECOND_SQUARED_PER_G;
  const totalG = Math.hypot(lateralG, longitudinalG);
  const markerX = 150 + clamp(lateralG / DISPLAY_MAX_G, -1, 1) * 108;
  const markerY = 150 + clamp(longitudinalG / DISPLAY_MAX_G, -1, 1) * 108;
  const tires = [
    snapshot.tires?.frontLeftTemp,
    snapshot.tires?.frontRightTemp,
    snapshot.tires?.rearLeftTemp,
    snapshot.tires?.rearRightTemp
  ];
  const validTires = tires.filter((value): value is number => value != null && Number.isFinite(value));
  const hottestTire = validTires.length > 0 ? Math.max(...validTires) : undefined;

  return (
    <section className={`race-dashboard gfocus-dashboard ${snapshot.connected ? "race-live" : "race-stale"}`}>
      <header className="gfocus-topbar">
        <div className="gfocus-title">
          <span>FH6</span>
          <strong>G-FORCE FOCUS</strong>
        </div>
        <div className="gfocus-status">
          <GForceFocusStat
            label="Link"
            tone={connectionStatus === "connected" && snapshot.connected ? "green" : "red"}
            value={formatConnection(connectionStatus, snapshot)}
          />
          <GForceFocusStat label="RX" unit="Hz" tone="cyan" value={formatHz(clientMetrics.estimatedMessageHz)} />
          <GForceFocusStat label="Age" unit="ms" tone="yellow" value={formatMilliseconds(clientMetrics.renderSnapshotAgeMs)} />
        </div>
      </header>
      <ShiftLights rpmRatio={rpmRatio} />
      <main className="gfocus-layout">
        <aside className="gfocus-rail gfocus-left">
          <GForceFocusStat label="Speed" unit="km/h" tone="cyan" value={formatSpeedKmh(snapshot.vehicle.speedKmh)} />
          <GForceFocusStat label="Gear" tone="yellow" value={gearLabel(snapshot.vehicle.gear)} />
          <GForceFocusStat label="RPM" value={formatInteger(snapshot.vehicle.rpm)} />
          <GForceFocusStat label="Throttle" tone="green" value={formatPercent(snapshot.input.throttle)} />
          <GForceFocusStat label="Brake" tone="red" value={formatPercent(snapshot.input.brake)} />
        </aside>

        <section className="gfocus-meter-panel">
          <svg className="gfocus-meter" viewBox="0 0 300 300" role="img" aria-label="G-force load transfer">
            <circle className="gfocus-ring gfocus-ring-outer" cx="150" cy="150" r="124" />
            <circle className="gfocus-ring" cx="150" cy="150" r="93" />
            <circle className="gfocus-ring" cx="150" cy="150" r="62" />
            <circle className="gfocus-ring" cx="150" cy="150" r="31" />
            <line className="gfocus-axis" x1="26" x2="274" y1="150" y2="150" />
            <line className="gfocus-axis" x1="150" x2="150" y1="26" y2="274" />
            <circle className="gfocus-dot" cx={markerX} cy={markerY} r="10" />
          </svg>
          <div className="gfocus-primary-readout">
            <span>Total Load</span>
            <strong>{formatNumber(totalG, 2)}<em>G</em></strong>
          </div>
        </section>

        <aside className="gfocus-rail gfocus-right">
          <GForceFocusStat label="Lat G" unit="G" tone="cyan" value={formatSignedNumber(lateralG, 2)} />
          <GForceFocusStat label="Long G" unit="G" tone="yellow" value={formatSignedNumber(longitudinalG, 2)} />
          <GForceFocusStat label="Accel X" value={formatSignedNumber(accelX, 2)} />
          <GForceFocusStat label="Accel Y" value={formatSignedNumber(accelY, 2)} />
          <GForceFocusStat label="Accel Z" value={formatSignedNumber(accelZ, 2)} />
          <GForceFocusStat label="Hot Tire" tone="green" value={formatTemperatureC(hottestTire)} />
        </aside>
      </main>
    </section>
  );
}

function DashboardApp() {
  const { snapshot, clientMetrics, connectionStatus, dashboardLayout, renderHz } = useTelemetry();
  const layout = selectedDashboardLayout(dashboardLayout);
  const stageClass = dashboardStageClass(layout);

  return (
    <main className={`dashboard-stage race-stage ${stageClass}`}>
      {layout === "gforce" ? (
        <GForceFocusDashboard
          connectionStatus={connectionStatus}
          clientMetrics={clientMetrics}
          renderHz={renderHz}
          snapshot={snapshot}
        />
      ) : layout === "minimal" ? (
        <MinimalHudDashboard
          connectionStatus={connectionStatus}
          clientMetrics={clientMetrics}
          renderHz={renderHz}
          snapshot={snapshot}
        />
      ) : layout === "mobile-race" ? (
        <MobileRaceDashboard
          connectionStatus={connectionStatus}
          clientMetrics={clientMetrics}
          renderHz={renderHz}
          snapshot={snapshot}
        />
      ) : layout === "engineer" ? (
        <TelemetryEngineerDashboard
          connectionStatus={connectionStatus}
          clientMetrics={clientMetrics}
          renderHz={renderHz}
          snapshot={snapshot}
        />
      ) : layout === "time-attack" ? (
        <TimeAttackDashboard
          connectionStatus={connectionStatus}
          clientMetrics={clientMetrics}
          renderHz={renderHz}
          snapshot={snapshot}
        />
      ) : (
        <RaceTelemetryDashboard
          connectionStatus={connectionStatus}
          clientMetrics={clientMetrics}
          renderHz={renderHz}
          snapshot={snapshot}
        />
      )}
    </main>
  );
}

export function App() {
  if (window.location.pathname.startsWith("/settings")) {
    return <SettingsPage />;
  }

  return <DashboardApp />;
}
