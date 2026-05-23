type Props = {
  rpm: number;
  maxRpm?: number;
};

export function RpmPanel({ rpm, maxRpm = 8000 }: Props) {
  const ratio = Math.max(0, Math.min(1, rpm / maxRpm));

  return (
    <section className="metric-card" aria-label="RPM">
      <div className="metric-header">
        <span className="metric-label">RPM</span>
        <span className="metric-readout">{Math.round(rpm).toLocaleString()}</span>
      </div>
      <div className="rpm-track">
        <div className="rpm-fill" style={{ width: `${ratio * 100}%` }} />
      </div>
      <div className="metric-unit">Max {Math.round(maxRpm).toLocaleString()}</div>
    </section>
  );
}
