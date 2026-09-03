"use client";

import { useMemo } from "react";
import type { ProvenanceEdge, ProvenanceGraph as Graph, ProvenanceNode } from "@/lib/contracts";
import { hostOf } from "@/lib/format";

const NODE_W = 168;
const NODE_H = 52;
const COL_GAP = 78;
const ROW_GAP = 20;

type Placed = ProvenanceNode & { x: number; y: number; column: number };

/**
 * One song, two chains — drawn.
 *
 * This is the single idea that makes the difference between lookup and
 * investigation legible: the master licenses cleanly while the composition traces
 * through a catalog sale into a dispute. Every edge carries the sources that
 * justify it, so no line on this diagram is unsupported.
 */
export function ProvenanceGraph({ graph }: { graph: Graph | null }) {
  const layout = useMemo(() => (graph ? place(graph) : null), [graph]);

  if (!graph || !layout) return <p className="empty">No chain traced yet.</p>;

  const { nodes, width, height } = layout;
  const byId = new Map(nodes.map((node) => [node.id, node]));

  return (
    <div className="provenance">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={Math.min(height, 460)}
        role="img"
        aria-label={`Chain of title for ${graph.title}`}
      >
        <g>
          {graph.edges.map((edge, index) => {
            const from = byId.get(edge.from);
            const to = byId.get(edge.to);
            if (!from || !to) return null;
            return (
              <EdgeLine key={`${edge.from}-${edge.to}-${index}`} edge={edge} from={from} to={to} index={index} />
            );
          })}
        </g>
        <g>
          {nodes.map((node) => (
            <NodeBox key={node.id} node={node} />
          ))}
        </g>
      </svg>

      <div className="provenance__legend stack-tight">
        {graph.chains.map((chain) => (
          <div key={chain} className="row" style={{ gap: 8 }}>
            <span className={`risk-dot ${graph.resolved?.[chain] ? "risk-green" : "risk-amber"}`} />
            <span className="small">
              {chain} chain — {graph.resolved?.[chain] ? "resolved" : "not established"}
            </span>
          </div>
        ))}

        {graph.open_questions.length > 0 && (
          <div className="banner" style={{ marginTop: 8 }}>
            <strong className="small">Open questions</strong>
            <ul className="small" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {graph.open_questions.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function EdgeLine({
  edge,
  from,
  to,
  index,
}: {
  edge: ProvenanceEdge;
  from: Placed;
  to: Placed;
  index: number;
}) {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  const mid = (x1 + x2) / 2;
  const path = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
  const encumbers = edge.kind === "encumbers" || edge.kind === "party_to";

  return (
    <g>
      <path
        d={path}
        className={`edge edge--${edge.kind}${encumbers ? " edge--danger" : ""}`}
        style={{ animationDelay: `${index * 60}ms` }}
      />
      {edge.kind === "transferred" && "year" in edge && edge.year ? (
        <text x={mid} y={(y1 + y2) / 2 - 6} className="edge__label" textAnchor="middle">
          {String(edge.year)}
        </text>
      ) : null}
      {edge.sources?.length ? <title>{edge.sources.map(hostOf).join(", ")}</title> : null}
    </g>
  );
}

function NodeBox({ node }: { node: Placed }) {
  const label = node.label.length > 26 ? `${node.label.slice(0, 25)}…` : node.label;
  const role = typeof node.role === "string" ? node.role.replace(/_/g, " ") : node.kind;

  return (
    <g transform={`translate(${node.x} ${node.y})`}>
      <rect width={NODE_W} height={NODE_H} rx={5} className={`node node--${node.kind}`} />
      <text x={10} y={20} className="node__label">
        {label}
      </text>
      <text x={10} y={38} className="node__role">
        {role}
      </text>
      <title>{node.label}</title>
    </g>
  );
}

/** Columns by node kind: the item, its chains, its holders, then encumbrances. */
function place(graph: Graph): { nodes: Placed[]; width: number; height: number } {
  const order: Record<string, number> = { item: 0, chain: 1, holder: 2, litigation: 3 };
  const columns: ProvenanceNode[][] = [[], [], [], []];
  for (const node of graph.nodes) columns[order[node.kind] ?? 2].push(node);

  const nodes: Placed[] = [];
  columns.forEach((column, index) => {
    column.forEach((node, row) => {
      nodes.push({
        ...node,
        column: index,
        x: index * (NODE_W + COL_GAP),
        y: row * (NODE_H + ROW_GAP),
      });
    });
  });

  const rows = Math.max(1, ...columns.map((column) => column.length));
  return {
    nodes,
    width: columns.length * (NODE_W + COL_GAP) - COL_GAP + 4,
    height: rows * (NODE_H + ROW_GAP) + 8,
  };
}
