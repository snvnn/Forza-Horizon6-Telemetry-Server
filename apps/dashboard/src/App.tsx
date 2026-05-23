import { ConnectionStatus } from "./components/ConnectionStatus";
import { GearPanel } from "./components/GearPanel";
import { PedalBars } from "./components/PedalBars";
import { RpmPanel } from "./components/RpmPanel";
import { SpeedPanel } from "./components/SpeedPanel";
import { TireTemps } from "./components/TireTemps";
import { useTelemetry } from "./telemetry/useTelemetry";

function numberOrDash(value: number | undefined, fractionDigits = 0): string {
  if (value == null || !Number.isFinite(value)) {
    return "--";
  }
  return value.toFixed(fractionDigits);
}

export function App() {
  const { snapshot, connectionStatus, renderHz } = useTelemetry();

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">Forza Data Out</p>
          <h1>Telemetry Monitor</h1>
        </div>
        <ConnectionStatus status={connectionStatus} snapshot={snapshot} renderHz={renderHz} />
      </header>

      {!snapshot ? (
        <section className="waiting-panel">Waiting for telemetry...</section>
      ) : (
        <section className="dashboard-grid">
          <SpeedPanel speedKmh={snapshot.vehicle.speedKmh} />
          <GearPanel gear={snapshot.vehicle.gear} />
          <RpmPanel rpm={snapshot.vehicle.rpm} maxRpm={snapshot.vehicle.maxRpm} />
          <PedalBars
            throttle={snapshot.input.throttle}
            brake={snapshot.input.brake}
            steer={snapshot.input.steer}
          />
          <section className="metric-card stat-card" aria-label="Power and torque">
            <div className="metric-label">Powertrain</div>
            <div className="stat-row">
              <span>Power</span>
              <strong>{numberOrDash(snapshot.vehicle.powerKw)} kW</strong>
            </div>
            <div className="stat-row">
              <span>Torque</span>
              <strong>{numberOrDash(snapshot.vehicle.torqueNm)} Nm</strong>
            </div>
            <div className="stat-row">
              <span>Boost</span>
              <strong>{numberOrDash(snapshot.vehicle.boost, 2)}</strong>
            </div>
          </section>
          <TireTemps tires={snapshot.tires} />
        </section>
      )}
    </main>
  );
}
