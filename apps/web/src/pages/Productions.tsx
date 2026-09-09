import { Link, useNavigate } from "react-router-dom";
import { ArrowUpRight, Plus, Shield, Upload } from "lucide-react";
import { progressPercent } from "@clearframe/shared";
import { Bar, Button, Card, Empty, Pill, StatusPill } from "@/components/ui";
import { money, stamp } from "@/lib/format";
import { productionTone } from "@/lib/status";
import { useSlate } from "@/hooks/useSlate";

export function Productions() {
  const { productions } = useSlate();
  const navigate = useNavigate();

  return (
    <>
      <div className="between">
        <div>
          <h1>Productions</h1>
          <p className="lede">Every clearance pass you have run, and what is still open on each.</p>
        </div>
        <Button icon={<Plus size={14} />} onClick={() => navigate("/productions/new")}>New pass</Button>
      </div>

      <div style={{ marginTop: 30 }}>
        {!productions.length ? (
          <Empty
            title="Start with a screenplay"
            action={<Button icon={<Upload size={14} />} onClick={() => navigate("/productions/new")}>Start a clearance pass</Button>}
          >
            Upload a script and ClearFrame breaks it down, researches each rights item against the live web,
            and hands you what needs a decision.
          </Empty>
        ) : (
          <div className="stack">
            {productions.map((p) => (
              <Link key={p.id} to={`/productions/${p.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                <Card className="card--button">
                  <div className="between">
                    <div>
                      <h2>{p.title}</h2>
                      <div className="table__sub mono" style={{ marginTop: 5 }}>
                        {p.format} · {p.script ?? "no script"}{p.cuts > 1 ? ` · cut ${p.cuts}` : ""}
                      </div>
                    </div>
                    <div className="row" style={{ gap: 8 }}>
                      {p.signed && <Pill tone="green"><Shield size={11} /> Signed</Pill>}
                      <StatusPill status={productionTone(p.status)} />
                    </div>
                  </div>

                  <div className="row row-wrap mono muted" style={{ marginTop: 16, gap: 22, fontSize: 12.5 }}>
                    <span>{p.total} findings</span>
                    <span>{p.resolved} resolved</span>
                    <span>{p.review} in review</span>
                    <span>{p.open} in progress</span>
                    {p.withdrawn > 0 && <span>{p.withdrawn} withdrawn</span>}
                  </div>

                  <div style={{ marginTop: 14 }}><Bar percent={progressPercent(p)} /></div>

                  <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
                    <span className="note mono">
                      {money(p.spent_micros)} of {money(p.budget_cap_micros)} · updated {stamp(p.updated_at)}
                    </span>
                    <span className="row" style={{ fontSize: 13, gap: 5 }}>Open <ArrowUpRight size={13} /></span>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
