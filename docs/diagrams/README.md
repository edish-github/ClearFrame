# Diagrams

Mermaid sources in `src/`, rendered PNGs in `png/`.

GitHub renders Mermaid natively inside markdown, so `README.md` and
`architecture.md` embed the source directly and stay in sync with edits. The PNGs
exist because Devpost does not render Mermaid, and because a raster is what goes
into a slide.

Regenerate after editing a source:

```bash
./render.sh
```

`render.sh` installs `@mermaid-js/mermaid-cli` if it is missing and renders every
`src/*.mmd` at 2x against `mermaid.config.json`, which carries the product's
palette so the diagrams match the interface.

| File | What it shows |
|---|---|
| `01-system-context` | The four planes, and the boundary that says the API never calls a model |
| `02-clearance-pass-sequence` | One finding from upload to armed watch, including the verifier challenge branch |
| `03-data-model-er` | Fourteen tables, with the column comments that explain why each exists |
| `04-finding-lifecycle` | The state machine, including the two edges that point backwards |
| `05-delta-reclearance` | What a second cut costs, and what it does not |
| `06-ledger-integrity` | Hash chaining, the append-only trigger, and what tampering looks like |
| `07-deployment` | Cloud Run topology, one image and two entrypoints |
