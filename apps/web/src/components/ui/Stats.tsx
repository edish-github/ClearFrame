import { pad2 } from "@/lib/format";

export interface Tally { total: number; resolved: number; review: number; open: number; withdrawn: number; }

export function Stats({ tally }: { tally: Tally }) {
  const cells: [string, number][] = [
    ["Findings", tally.total],
    ["Resolved", tally.resolved],
    ["Needs review", tally.review],
    ["In progress", tally.open],
  ];
  return (
    <div className="stats">
      {cells.map(([label, value]) => (
        <div className="stat" key={label}>
          <div className="stat__value">{pad2(value)}</div>
          <div className="stat__label">{label}</div>
        </div>
      ))}
    </div>
  );
}
