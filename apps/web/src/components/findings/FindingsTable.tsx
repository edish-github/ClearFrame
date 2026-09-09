import { useNavigate } from "react-router-dom";
import { CATEGORY_LABEL, type Finding } from "@clearframe/shared";
import { Card, Risk, StatusPill } from "@/components/ui";
import { sceneLabel } from "@/lib/format";

export function FindingsTable({ findings, emptyNote }: { findings: Finding[]; emptyNote: string }) {
  const navigate = useNavigate();
  return (
    <Card pad={false} style={{ padding: "16px 10px 4px" }}>
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 110 }}>Risk</th>
            <th>Item</th>
            <th style={{ width: 100 }}>Type</th>
            <th style={{ width: 150 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {findings.map((f) => (
            <tr key={f.id} className="is-clickable" onClick={() => navigate(`/findings/${f.id}`)}>
              <td><Risk level={f.risk} /></td>
              <td>
                <div style={{ fontWeight: 500 }} className={f.status === "withdrawn" ? "table__dim" : undefined}>
                  {f.item}
                </div>
                <div className="table__sub mono">
                  {sceneLabel(f.scene)}
                  {f.page ? ` · Page ${f.page}` : ""}
                  {f.chains.length > 1 ? ` · ${f.chains.length} chains` : ""}
                </div>
              </td>
              <td className="muted">{CATEGORY_LABEL[f.category]}</td>
              <td><StatusPill status={f.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {!findings.length && <div className="note" style={{ padding: "18px 12px" }}>{emptyNote}</div>}
    </Card>
  );
}
