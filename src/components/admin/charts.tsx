/**
 * The two chart forms the canvas draws — an accent line with a faint area
 * under it, and a row of heat cells whose opacity is the value. Plain SVG and
 * divs, tokens only, no library: at fest scale there is nothing to gain from
 * one, and the design's charts are deliberately this quiet.
 */

export interface LinePoint {
  label: string;
  value: number;
}

export const LineArea = ({
  points,
  height = 150,
  marker,
}: {
  points: LinePoint[];
  height?: number;
  /** Optional vertical dashed marker at a label — "poster went out". */
  marker?: { label: string; text: string };
}) => {
  const width = 620;
  const pad = 10;
  const max = Math.max(1, ...points.map((p) => p.value));
  const n = Math.max(1, points.length - 1);
  const x = (i: number) => pad + (i * (width - pad * 2)) / n;
  const y = (v: number) => height - pad - (v / max) * (height - pad * 2);

  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${line} ${x(points.length - 1).toFixed(1)},${height} ${x(0).toFixed(1)},${height}`;
  const markerIndex = marker ? points.findIndex((p) => p.label === marker.label) : -1;

  if (points.length < 2) {
    return <div className="grid h-[150px] place-items-center text-[12.5px] text-neutral-500">Not enough days yet to draw a trend.</div>;
  }

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="block h-[150px] w-full" role="img" aria-label="Trend">
      <polyline points={area} fill="var(--color-accent-900)" stroke="none" opacity=".55" />
      <polyline points={line} fill="none" stroke="var(--color-accent)" strokeWidth="2" />
      <line x1={pad} y1={height} x2={width - pad} y2={height} stroke="var(--color-divider)" strokeWidth="1" />
      {markerIndex >= 0 && marker ? (
        <>
          <line x1={x(markerIndex)} y1="0" x2={x(markerIndex)} y2={height} stroke="var(--color-neutral-700)" strokeWidth="1" strokeDasharray="3 4" />
          <text x={x(markerIndex) - 6} y="12" textAnchor="end" fontSize="10" fill="var(--color-neutral-500)">
            {marker.text}
          </text>
        </>
      ) : null}
    </svg>
  );
};

export const HeatRow = ({ cells }: { cells: Array<{ label: string; value: number }> }) => {
  const max = Math.max(1, ...cells.map((c) => c.value));
  return (
    <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}>
      {cells.map((c) => (
        <div key={c.label} title={`${c.label}: ${c.value}`}>
          <div className="h-[38px] rounded-[3px] bg-accent" style={{ opacity: c.value === 0 ? 0.08 : Math.max(0.12, c.value / max) }} />
          <div className="mt-[5px] text-center text-[9.5px] text-neutral-500">{c.label}</div>
        </div>
      ))}
    </div>
  );
};
