# The war room

The clearance war room: a Next.js app where **the film is the protagonist**. The
cut plays as the hero surface with the clearance heat strip under its real frames;
clicking a red region scrubs to the frame where the poster hangs or the song
swells. Findings annotate the movie, not a document.

```bash
pnpm install
cp .env.example .env.local     # point at your services
pnpm dev                       # http://localhost:3000
```

Or run the whole stack — five services and this app — from the repository root:

```bash
make dev
```

## The one rule

**One-way data flow.** This app reads projections and posts human decisions. It
never calls an agent and never writes a finding. That is why the live demo does
not break, and why a compromised browser cannot forge a rights claim.

```
war room ──read──▶ orchestrator   (projections, pass control)
         ──write─▶ ledger API     (decisions only, role enforced server-side)
```

The browser never talks to a ClearFrame service directly. Every request goes
through this app's own server (`src/lib/upstream.ts`), which attaches a Google
identity token for the private Cloud Run service and names the acting human in a
header the ledger accepts only from this service account.

## Surfaces

| Route | What it is |
|---|---|
| `/` | The slate — every production in clearance, and readiness |
| `/projects/[id]` | Upload a cut, start a pass, ship the report, verify the ledger |
| `/projects/[id]/pass/[passId]` | **The war room**: player, heat strip, risk board, crew feed, budget |
| `/projects/[id]/approvals` | The counsel gate and the outreach queue |
| `/projects/[id]/watches` | Armed monitors and their reopen history |
| `/projects/[id]/report` | Render and ship the E&O pack |

## Components worth knowing

| Component | Note |
|---|---|
| `HeatStrip.tsx` ★ | Regions arrive pre-computed as percentages with a hairline floor, so the strip and the report can never disagree. |
| `CrewFeed.tsx` | Challenges render as **threaded replies** under the finding they attack — the argument is visible, not inferred. |
| `ProvenanceGraph.tsx` | One song, two chains, drawn. Every edge carries the sources that justify it. |
| `ApprovalModal.tsx` | The gate. A producer sees no approve controls — absent, not disabled. |
| `BudgetMeter.tsx` | Reports whether its own numbers are calibrated. |
| `CutPlayer.tsx` | Plays picture; for a script pass it shows the anchor rather than pretending there is footage. |

## Design

Every colour, size and timing lives in `src/styles/tokens.css`. Restyling the
product is editing that one file — no component hard-codes a value, and a light
grade is already stubbed there.

Motion is spent in exactly three places: findings sliding into the feed,
heat-strip regions resolving colour, and the provenance graph drawing its edges.
Nowhere else. The interface should feel like a production office at 10pm where
nobody is typing.

The vocabulary is Hollywood — passes, crews, the 1st AD, the slate, cleared for
distribution. Never "jobs", "workers", or "records".

## Types

Generated from the Python contracts; never hand-edited:

```bash
pnpm generate      # → src/lib/contracts.ts
```

## Roles

In production the role comes from the signed-in identity. For the public demo,
`NEXT_PUBLIC_DEMO_IDENTITY=true` shows a role switcher so a judge can walk the
counsel gate without four accounts. It grants nothing: authority still comes from
the subject's role binding, checked in the ledger, and the API returns 403 either
way.

## Development fixture

To iterate on the design without spending API credit:

```bash
make fixture       # writes a populated project into .local/ — dev only, never demo content
make dev
```
