# The three-minute demo — shot list and recording checklist

Four acts. Two of them are beats no simulated project can produce, and they get
the screen time a lesser demo spends on a feature tour.

**Direction rules, before any shot:**
1. The film is the protagonist. Every beat is photographed on the cut, never on a
   document.
2. The vocabulary is Hollywood — passes, crews, the 1st AD, cleared for
   distribution. Never "jobs", "workers", "records".
3. Record a real pass. Cut the waiting; never fake the doing.
4. The PDF appears for three seconds as proof. The email never appears at all —
   only the gate and the queue counter.
5. Captions carry the narration. The video has to work muted.

---

## Act I · 0:00–0:20 — the film is the protagonist

| Time | On screen | What it proves |
|---|---|---|
| 0:00–0:08 | Black. One line: **"Somewhere in this film is a lawsuit."** Cut to the short playing in the war room. | Attention, and that the subject is a movie. |
| 0:08–0:20 | The upload lands. The heat strip materialises under the frames — every item grey, resolving to colour as recon completes. | Breakdown, and instant scale. |

**Capture:** screen-record the real upload from the war room's project console.
The strip resolves live as findings land — no cut needed between upload and
colour.

---

## Act II · 0:20–1:20 — agents argue, live

| Time | On screen | What it proves |
|---|---|---|
| 0:20–0:50 | "Investigate." The crew feed ignites. Camera on the Music crew tracing the cover in scene 1; citation cards stack with real sources; the provenance graph draws the master chain clean. | Real autonomy on the live web. |
| 0:50–1:20 | **The beat.** The Verifier files a challenge — the load-bearing citation is stale. The re-run, chained by `previous_interaction_id`, comes back with a different answer. The feed shows the argument as a thread. | Agents supervising agents, verifiably live. |

**Capture:** the crew feed renders a challenge as a threaded reply under the
finding it attacks, with its grounds and the citation that justifies them —
`CrewFeed.tsx`. Click the finding line to expand its citation cards. The chaining
is visible in the item drawer: a re-run shows "chained" beside its confidence.

**If the Verifier does not challenge on the take:** do not stage one. Run the pass
again — the challenge rate is tuned to roughly one finding in five to ten, so a
second take usually produces one. If it still does not, the film uses a different
item; the beat is only worth having if it is real.

---

## Act III · 1:20–2:20 — the gate, then the delta

| Time | On screen | What it proves |
|---|---|---|
| 1:20–1:50 | Risk Counsel flags the item red: the chain runs into a dispute. Three mitigations with cost deltas. The Counsel role approves the licence inquiry; the queue counter ticks; the ledger appends on screen. | Judgement, a human gate, real actions. |
| 1:50–2:20 | The director uploads a revised cut. The delta pass re-clears only what changed while the rest stay green. Three seconds on the rendered E&O report — hundreds of citations — then back to the film. | Delta re-clearance, and the artefact, demoted. |

**Capture:** open the approval modal as Producer first — the approve controls are
*absent*, with one line saying why. Switch the role selector to Counsel and the
same modal grows its buttons. One second on that switch sells the whole IAM story.
The delta counts appear when you start a delta pass from the project console;
`demo/film/PLANTED-ITEMS.md` records the nine changes so the number is checkable.

---

## Act IV · 2:20–3:00 — the monitor reopens it

| Time | On screen | What it proves |
|---|---|---|
| 2:20–2:45 | Title: **"Three weeks later."** A monitor webhook lands. The Sentinel wakes the 1st AD. The item flips red on the strip. Counsel's alert appears with the new filing cited. | Continuous clearance — the unfakeable act. |
| 2:45–3:00 | End card over the film's final frame: **Cleared for distribution.** Weeks → under an hour. Specialist fees → API cost. Every claim cited, live. **"ClearFrame."** | The numbers, and the memory hook. |

**Capture:** see `demo/monitor-target/README.md`. Make the change on the controlled
page well before the shoot and film the arrival. Schedule the timing; never fake
the event.

---

## Recording checklist

- [ ] Fresh demo project seeded and healthy (`make seed`)
- [ ] The slate page's readiness banner is green — it reports exactly what is wired
- [ ] `DEMO_IDENTITY=true` so the role switcher is available for the gate beat
- [ ] Budget cap set high enough that no take dies at the cap mid-shot
- [ ] Browser at 1920×1080, zoom 100%, no extensions, no notifications
- [ ] Two full passes recorded, so there is a spare of every beat
- [ ] The challenge thread is legible at 1× without pausing
- [ ] The monitor citation is legible at 1× without pausing
- [ ] The delta counter is readable
- [ ] Cut to ≤ 3:00, hook lands inside 0:20
- [ ] Captions burned in; watched once muted
- [ ] Watched once at 1× as a stranger: anything that explains rather than shows is cut
- [ ] Uploaded public, no login, English captions

## What must never appear in the video

- Anything produced by `make fixture`. That is a development fixture for iterating
  on the design without spending API credit, and it is not demo content. The demo
  runs a real pass.


- A fabricated finding, citation, or webhook.
- A sent email — ClearFrame has no send capability, and the queue is the feature.
- Any claim that the system decides anything legal. The gate is the product.
