# Grounding corpora — provenance and licence

Risk Counsel is grounded on the documents in this directory. Two rules govern what
may be dropped here, and both matter for the submission as much as for the law:

1. **Every document records where it came from and under what licence.** A grounding
   corpus of unattributed PDFs is not a system an enterprise buyer can adopt.
2. **Nothing copyrighted is committed to this repository.** Licensed underwriting
   manuals and network clearance handbooks are loaded into the Agent Builder data
   stores at deploy time from a private bucket, and referenced here by title only.

## What is in the repository today

| File | Origin | Licence | Status |
|---|---|---|---|
| `clearance-handbooks/practice-notes.md` | Written for this project by the team, summarising publicly documented clearance practice. Original prose. | Apache-2.0, with the repository | Working substitute |
| `eo-underwriting/underwriting-notes.md` | Written for this project by the team, summarising publicly documented E&O application requirements. Original prose. | Apache-2.0, with the repository | Working substitute |

These are **team-authored working notes, not industry documents**. They are good
enough to exercise the grounding path end to end and to keep Risk Counsel citing a
passage rather than reciting from memory. They are not a substitute for the real
corpora in front of a real production.

## What must be loaded before this is used on a real title

| Document class | How it is obtained | Where it goes |
|---|---|---|
| E&O underwriting guidelines from the production's carrier | From the broker, per policy | Private GCS bucket → Agent Builder data store `eo-underwriting` |
| Network / streamer clearance handbook for the delivering platform | From the distributor's delivery specs | Private bucket → data store `clearance-handbooks` |
| Production's own legal precedent notes | From production counsel | Private bucket → data store `clearance-handbooks` |

`infra/scripts/bootstrap.sh` creates both data stores. Loading them is a deliberate,
separately-authorised step: see `docs/SECURITY.md`.

## Why the corpus is separated from the prompt

A rulebook that lives in a prompt cannot be cited, versioned, or swapped per
production. A rulebook that lives in a data store can, and Risk Counsel's output
carries the passage reference — which is exactly what makes its scoring auditable
rather than assertive.
