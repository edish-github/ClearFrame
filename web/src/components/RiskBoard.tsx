"use client";

import { useState } from "react";
import type { Item, RiskBoard as Board } from "@/lib/contracts";
import { ITEM_TYPE_LABEL, RISK_LABEL, riskClass } from "@/lib/format";

type Props = {
  board: Board | null;
  selectedItemId?: string | null;
  onSelect: (itemId: string) => void;
};

const COLUMNS: Array<{ key: "red" | "amber" | "green" | "unknown"; label: string }> = [
  { key: "red", label: "Red" },
  { key: "amber", label: "Amber" },
  { key: "unknown", label: "Open" },
  { key: "green", label: "Green" },
];

/** Red and amber in full; green collapsed, because a cleared item is not news. */
export function RiskBoard({ board, selectedItemId, onSelect }: Props) {
  const [showGreen, setShowGreen] = useState(false);
  if (!board) return <p className="empty">No register yet.</p>;

  return (
    <div className="board">
      {COLUMNS.map(({ key, label }) => {
        const items = board.columns?.[key] ?? [];
        const collapsed = key === "green" && !showGreen;

        return (
          <section key={key} className="board__column">
            <header className="board__head">
              <span className="row" style={{ gap: 6 }}>
                <span className={`risk-dot ${riskClass(key)}`} />
                <strong className="small">{label}</strong>
                <span className="mono xsmall dim">{items.length}</span>
              </span>
              {key === "green" && items.length > 0 && (
                <button type="button" className="btn btn-ghost xsmall" onClick={() => setShowGreen((v) => !v)}>
                  {showGreen ? "collapse" : "expand"}
                </button>
              )}
            </header>

            {items.length === 0 && <p className="empty xsmall">none</p>}

            {collapsed ? (
              <p className="xsmall dim">{items.length} cleared ✓</p>
            ) : (
              <ul className="board__list">
                {items.map((item: Item) => (
                  <li key={item.item_id}>
                    <button
                      type="button"
                      className={`card${selectedItemId === item.item_id ? " is-selected" : ""}`}
                      onClick={() => onSelect(item.item_id)}
                    >
                      <span className="card__title truncate">{item.title}</span>
                      <span className="card__meta xsmall dim">
                        {item.timecode?.scene ? `sc ${item.timecode.scene} · ` : ""}
                        {ITEM_TYPE_LABEL[item.type]} · {item.status.replace(/_/g, " ")}
                      </span>
                      {key !== "green" && (
                        <span className="card__risk xsmall">{RISK_LABEL[key]}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
