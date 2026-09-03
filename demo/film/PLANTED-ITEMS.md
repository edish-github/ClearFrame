# Planted items — THE LAST HOUR

The most important file in `demo/`. Every clearable element in the test script was
placed deliberately, so that every discovery on screen during the demo is a real
discovery about the real world — not a scripted reveal.

**Rule for this file:** an item belongs here only if a person can find its rights
position on the public web. If a pass cannot establish it, that is a finding about
the item, and the row below is updated to say so. Nothing in this file is a
prediction the demo depends on.

## Verification status

| | |
|---|---|
| Script written | ✅ `cut-01/script.fountain`, `cut-02/script.fountain` |
| Items enumerated | ✅ below |
| **Expected findings confirmed by a live pass** | ⬜ **not yet run** — see "How to confirm" |
| Picture shot | ⬜ blocked on the shoot decision (Reel 15, week one open question) |

The expected-finding column below states what the item *is*, which is a fact about
the script, and what the investigation *should be able to establish*, which is a
claim about the public record that the first live pass either confirms or refutes.
Confirm before the shoot; correct this file from the pass output, never the reverse.

## cut-01

| # | Scene | Type | Item | Why it was planted | What a pass should establish |
|---|---|---|---|---|---|
| 1 | 1 | music_cue | Modern cover of **"After the Ball"** (Charles K. Harris, 1891) | **The signature item.** One song, two chains that genuinely differ: an 1891 composition whose US copyright has long expired, and a modern master that has not. A lookup finds the song; only an investigation separates the chains. | Composition: public domain in the US, with the basis and year stated. Master: owned by whoever released the specific recording used — a live question with a live answer. |
| 2 | 1 | artwork | Hand-painted whale mural, signed | Background artwork with a visible signature. The "background is not cleared" trap. | Creator unidentified from the script alone; the item resolves as an unresolved chain, which is the honest outcome and at least amber. |
| 3 | 1 | brand | Coca-Cola can, logo to camera | A prominent, deliberately-framed mark from an owner with a documented IP posture. | Owner of record, live registrations, and a documented enforcement history. |
| 4 | 2 | artwork | Hokusai, *The Great Wave off Kanagawa* | A work everyone assumes is free. The interesting question is which reproduction is used and who holds rights in that reproduction. | Underlying work: public domain, with the basis stated. Any specific photographic reproduction may carry its own claim. |
| 5 | 2 | brand | Starbucks sticker on a laptop | Incidental, partly obscured mark — tests prominence judgement rather than ownership research. | Owner of record; prominence recorded as background. |
| 6 | 2 | footage | Archival newsreel, 1936 harbour strike | Archival provenance: the class of item that most often dissolves under scrutiny. | Whether a specific 1936 newsreel can be identified at all; if not, orphan-work signals recorded rather than a public-domain assumption. |
| 7 | 3 | brand | Maersk container livery | A trade dress crossing frame unmissably — a mark on a moving object. | Owner of record and registration status. |
| 8 | 4 | artwork | Frida Kahlo self-portrait postcard | A deceased artist whose estate actively administers rights. Tests the estate path. | Rights administered by an estate or licensing body; the answer is not "it's old". |
| 9 | 4 | lyric_quote | Opening line of *One Hundred Years of Solitude* | Literary quotation — a separate clearance from anything visual. | Rights holder for the work and the translation, which are separate. |
| 10 | 4 | likeness | "The Prime Minister" on the radio | An unnamed public figure referenced in dialogue. Tests whether extraction catches a likeness that is never seen. | Whether an identifiable person is depicted at all; probably not, and that is the correct finding. |
| 11 | 5 | artwork | 1977 concert poster with band logo | Two rights in one object: the poster's design and the band's mark. | Poster designer or promoter, and the mark's current owner — commonly different parties. |
| 12 | 5 | music_cue | Reprise of item 1 | Deliberate duplicate. The register must merge it with item 1 by content hash rather than clearing the same song twice. | One item, two anchors — visible in the delta and the register. |

## cut-02 — the delta

Nine deliberate changes, so the delta pass has a known-correct answer:

| # | Change | Expected delta behaviour |
|---|---|---|
| 1 | Mural gains a signature: "M. Okonkwo 2019" | Content hash changes → **re-researched** |
| 2 | Coca-Cola → Dr Pepper | Old item withdrawn, new item added |
| 3 | Starbucks sticker removed | Item **withdrawn** |
| 4 | Hokusai → Van Gogh, *Wheat Field with Cypresses* | Withdrawn + added |
| 5 | Maersk → Evergreen | Withdrawn + added |
| 6 | Kahlo → O'Keeffe | Withdrawn + added |
| 7 | *One Hundred Years of Solitude* → *The Old Man and the Sea* (and the quoted line) | Withdrawn + added |
| 8 | New scene 6: an unnamed 1980s pop record on a car radio | **Added** |
| 9 | Newsreel year 1936 → 1934 | Content hash changes → **re-researched** |

Everything else — the cover of "After the Ball", the concert poster, the Prime
Minister reference — must **inherit** its state, findings, citations and armed
watches untouched. That inheritance is the beat: a re-cut does not restart the
clearance.

## How to confirm (before the shoot)

```bash
uv run python scripts/run_local_pass.py \
  --file demo/film/cut-01/script.fountain --title "The Last Hour" --report
```

Then, for the delta:

```bash
uv run python scripts/run_local_pass.py \
  --file demo/film/cut-02/script.fountain --project <project_id> \
  --label cut-02 --mode delta
```

Update the tables above from what the pass actually returned. If an item cannot be
established, say so here — an honest unresolved item is a better demo beat than a
confident wrong one, and it is what the product is for.

## If the picture is shot rather than licensed

Every item above must be physically placed on set or in the edit, and the set
dresser needs this list. Items 1, 2, 6 and 11 are the ones worth protecting in the
schedule: they carry the two-chain beat, the background-artwork trap, the archival
provenance question, and the poster's split rights.
