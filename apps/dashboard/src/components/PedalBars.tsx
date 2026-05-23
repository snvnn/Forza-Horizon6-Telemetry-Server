type Props = {
  throttle: number;
  brake: number;
  clutch?: number;
  steer: number;
};

function percent(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

export function PedalBars({ throttle, brake, clutch = 0, steer }: Props) {
  const steerPercent = Math.max(-1, Math.min(1, steer)) * 50;

  return (
    <section className="metric-card pedal-card" aria-label="Inputs">
      <div className="metric-label">Inputs</div>
      <div className="bar-row">
        <span>Throttle</span>
        <div className="bar-track">
          <div className="bar-fill throttle-fill" style={{ width: `${percent(throttle)}%` }} />
        </div>
        <strong>{percent(throttle)}%</strong>
      </div>
      <div className="bar-row">
        <span>Brake</span>
        <div className="bar-track">
          <div className="bar-fill brake-fill" style={{ width: `${percent(brake)}%` }} />
        </div>
        <strong>{percent(brake)}%</strong>
      </div>
      <div className="bar-row">
        <span>Clutch</span>
        <div className="bar-track">
          <div className="bar-fill clutch-fill" style={{ width: `${percent(clutch)}%` }} />
        </div>
        <strong>{percent(clutch)}%</strong>
      </div>
      <div className="steer-row">
        <span>Steer</span>
        <div className="steer-track">
          <div className="steer-center" />
          <div
            className="steer-marker"
            style={{ transform: `translateX(${steerPercent}%)` }}
          />
        </div>
        <strong>{Math.round(steer * 100)}%</strong>
      </div>
    </section>
  );
}
