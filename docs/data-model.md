# Data model

Two rules run through the whole schema: money is an integer, and history is
append-only.

## Entities

```
orgs ──< users
  │
  └──< productions ──< cuts            one row per uploaded screenplay
            │
            ├──< findings ──< evidence      the sources, with retrieval snapshots
            │        ├──< decisions         who resolved it, why, and when
            │        ├──── outreach         one drafted inquiry, counsel gated
            │        └──── watches          the armed re-check
            │
            ├──< activity                   the human-readable feed
            ├──< cost_events                every provider call, in micro-dollars
            ├──< ledger                     hash-chained, append-only
            ├──< reports                    snapshots, signatures, stored PDFs
            └──< jobs                       durable queue
```

## Money

`budget_cap_micros` and `spent_micros` are `bigint` micro-dollars. Each provider
call inserts a `cost_events` row carrying real token counts or unit counts and
increments the production total in the same statement, so the meter can never
drift from its own audit trail.

## The ledger

| Column | Meaning |
|---|---|
| `production_id`, `seq` | Composite key. `seq` is allocated under a Postgres advisory lock so concurrent workers cannot fork the chain. |
| `ts`, `actor`, `event` | What happened, when, and who caused it. `actor` is a person's name or an agent role. |
| `prev_hash`, `hash` | `sha256` over the canonicalised entry including the previous hash. |

A trigger refuses `UPDATE` outright and refuses `DELETE` unless
`clearframe.allow_purge` is set for the transaction, which is how a retention
purge is performed deliberately rather than by an accidental cascade.

`verifyChain` recomputes from stored rows and returns the first `seq` where the
chain breaks, so tampering is not merely discouraged — it is locatable.

## Finding identity across cuts

- `item_key` = `CATEGORY|normalised item name`, unique per production.
- `content_hash` = normalised scene, page and context.

Same key, same hash → carried forward untouched.
Same key, different hash → `queued` and re-researched.
Key absent from a new cut → `withdrawn`, never deleted.

## Job queue

`jobs` is claimed with `FOR UPDATE SKIP LOCKED`, so any number of workers drain
it safely. Failures back off at 30s, 2m, 8m and then park in `failed`. A reaper
releases jobs whose worker vanished mid-run.
