type Props = {
  gear: number;
};

function formatGear(gear: number): string {
  if (gear < 0) {
    return "R";
  }
  if (gear === 0) {
    return "N";
  }
  return String(gear);
}

export function GearPanel({ gear }: Props) {
  return (
    <section className="metric-card gear-card" aria-label="Gear">
      <div className="metric-label">Gear</div>
      <div className="gear-value">{formatGear(gear)}</div>
    </section>
  );
}
