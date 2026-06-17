type Props = {
  speedKmh: number;
};

export function SpeedPanel({ speedKmh }: Props) {
  return (
    <section className="metric-card speed-card" aria-label="Speed">
      <div className="metric-label">Speed</div>
      <div className="speed-value">{Math.round(speedKmh)}</div>
      <div className="metric-unit">km/h</div>
    </section>
  );
}
