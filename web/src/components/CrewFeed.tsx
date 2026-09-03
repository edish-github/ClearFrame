"use client";

import { useMemo, useState } from "react";
import type { FeedEntry } from "@/lib/contracts";
import { hostOf, relativeTime, shortId } from "@/lib/format";

type Props = {
  feed: FeedEntry[];
  onSelectItem?: (itemId: string) => void;
};

type Thread = { entry: FeedEntry; replies: FeedEntry[] };

/**
 * The live crew feed — and the place the demo's best beat is actually visible.
 *
 * A challenge is not a status change. It renders as a threaded reply under the
 * finding it attacks, with its grounds and the citation that justifies them, so
 * a viewer sees the agents arguing rather than inferring it afterwards.
 */
export function CrewFeed({ feed, onSelectItem }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const threads = useMemo<Thread[]>(() => {
    const ordered = [...feed].sort((a, b) => (a.ts < b.ts ? -1 : 1));
    const byFinding = new Map<string, FeedEntry[]>();

    for (const entry of ordered) {
      if (entry.kind !== "challenge.filed") continue;
      const parent = (entry.detail as { finding_id?: string })?.finding_id;
      if (!parent) continue;
      byFinding.set(parent, [...(byFinding.get(parent) ?? []), entry]);
    }

    const threads: Thread[] = [];
    for (const entry of ordered) {
      if (entry.kind === "challenge.filed") continue;
      const findingId = findingIdOf(entry);
      threads.push({ entry, replies: (findingId && byFinding.get(findingId)) || [] });
    }
    return threads.reverse();
  }, [feed]);

  if (threads.length === 0) {
    return <p className="empty">The crew has not reported yet.</p>;
  }

  return (
    <ol className="feed">
      {threads.map(({ entry, replies }) => {
        const key = entry.event_id ?? `${entry.ts}-${entry.kind}`;
        const open = expanded.has(key);
        return (
          <li key={key} className="feed__row">
            <button
              type="button"
              className="feed__line"
              onClick={() => {
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                });
                if (entry.item_id) onSelectItem?.(entry.item_id);
              }}
            >
              <span className={`feed__dot crew-${entry.colour}`} />
              <span className="feed__agent mono">{entry.agent}</span>
              <span className="feed__message truncate">{entry.message}</span>
              <span className="feed__time xsmall dim">{relativeTime(entry.ts)}</span>
            </button>

            {open && <FeedDetail entry={entry} />}

            {replies.map((reply) => (
              <Challenge key={reply.event_id ?? reply.ts} entry={reply} />
            ))}
          </li>
        );
      })}
    </ol>
  );
}

function findingIdOf(entry: FeedEntry): string | null {
  const detail = entry.detail as { finding?: { finding_id?: string }; finding_id?: string };
  return detail?.finding?.finding_id ?? detail?.finding_id ?? null;
}

function Challenge({ entry }: { entry: FeedEntry }) {
  const challenge = (entry.detail as { challenge?: Record<string, unknown> })?.challenge ?? {};
  const grounds = String(challenge.grounds ?? "objection");
  const rationale = String(challenge.rationale ?? entry.message);
  const citations = (challenge.citations as Array<{ url: string }> | undefined) ?? [];

  return (
    <div className="feed__challenge">
      <div className="row" style={{ gap: 6 }}>
        <span className="tag" style={{ borderColor: "var(--crew-teal)", color: "var(--crew-teal)" }}>
          challenge · {grounds}
        </span>
        <span className="xsmall dim">{relativeTime(entry.ts)}</span>
      </div>
      <p className="small" style={{ margin: "6px 0" }}>{rationale}</p>
      {citations.length > 0 && (
        <div className="row wrap" style={{ gap: 6 }}>
          {citations.map((citation) => (
            <a
              key={citation.url}
              className="tag"
              href={citation.url}
              target="_blank"
              rel="noreferrer noopener"
            >
              {hostOf(citation.url)}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function FeedDetail({ entry }: { entry: FeedEntry }) {
  const finding = (entry.detail as { finding?: Record<string, unknown> })?.finding;
  const citations =
    (finding?.citations as Array<{ url: string; title?: string; authority?: string }> | undefined) ??
    [];

  return (
    <div className="feed__detail">
      {entry.item_id && (
        <div className="xsmall dim mono">item {shortId(entry.item_id)}</div>
      )}

      {citations.length > 0 ? (
        <ul className="cites">
          {citations.slice(0, 8).map((citation) => (
            <li key={citation.url}>
              <span className="tag">{citation.authority ?? "source"}</span>{" "}
              <a href={citation.url} target="_blank" rel="noreferrer noopener">
                {citation.title || hostOf(citation.url)}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <pre className="feed__json">{JSON.stringify(entry.detail, null, 2).slice(0, 1400)}</pre>
      )}
    </div>
  );
}
