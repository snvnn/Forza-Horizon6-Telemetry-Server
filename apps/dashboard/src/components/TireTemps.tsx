import type { TelemetrySnapshot } from "../telemetry/telemetryTypes";

type Props = {
  tires: TelemetrySnapshot["tires"];
};

export function TireTemps({ tires }: Props) {
  if (!tires) {
    return (
      <section className="metric-card" aria-label="Tire temperatures">
        <div className="metric-label">Tire Temps</div>
        <div className="empty-text">No tire data</div>
      </section>
    );
  }

  const items = [
    ["FL", tires.frontLeftTemp],
    ["FR", tires.frontRightTemp],
    ["RL", tires.rearLeftTemp],
    ["RR", tires.rearRightTemp]
  ] as const;

  return (
    <section className="metric-card tire-card" aria-label="Tire temperatures">
      <div className="metric-label">Tire Temps</div>
      <div className="tire-grid">
        {items.map(([label, value]) => (
          <div className="tire-cell" key={label}>
            <span>{label}</span>
            <strong>{Math.round(value)}</strong>
            <small>C</small>
          </div>
        ))}
      </div>
    </section>
  );
}
