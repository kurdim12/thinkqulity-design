# DEMO

Run `npm run demo:check` first. Red means do not demo.

It prints three outcomes, and they are not the same thing. **FAIL** is a state
someone can clear before the demo, and every one of them names the single
action that clears it. **NOTE** is a state that was measured, is genuinely
absent, and that nothing on this checklist can move — it is printed in full and
does not affect the exit code. **PASS** always shows the number it passed on,
so a green line can be checked rather than trusted.

---

## THE WOW

Paste Ahmad's own off-brand draft into **Compliance** → instant **FAIL** with
receipts: the exact hex that is not in his palette, and the register score
measured against his real captions → click **Apply fixes & re-check** → the
draft comes back rewritten **in Arabic, in his register** → **PASS**.

One moment, interactive, unfakeable. The audience watches a machine refuse to
approve work — which is the opposite of what they expect an AI demo to do, and
the reason they will remember it. Then it does the harder half: it does not
merely strip the offending hex and the invented percentages, it hands back
something he could actually post.

**Prepared paste text** (keep this in a scratch file, ready to paste):

```
Our new campaign uses a bold #7B2FF7 gradient and drives 340% more engagement
than any previous post, reaching 92% of our target demographic.
```

Why it fails, every time, deterministically:
- `#7B2FF7` is not in the sampled palette → **palette-claims violation**
- `340%` and `92%` appear nowhere in the data → **claims-linter violation**
- English marketing register vs his Arabic captions → **register warning**

The first two are Law: pure functions, no model involved. They cannot flake.
The third is a heuristic and labels itself one on screen — it warns, it never
vetoes. A machine does not get to veto a human's writing on character ratios.

### The second leg — English fluff in, his Arabic out

**Apply fixes & re-check** is the model half, and it is the half worth
narrating. What comes back is not the same English sentence with the hex
swapped out. It is an Arabic rewrite in his register — Levantine markers, his
sentence length, his punctuation habits — and it is re-checked live, on screen,
by both halves of the brain:

- **Law** runs again over the rewrite. Same pure functions, same evidence rows,
  no model. The palette and claims checks either clear it or they do not.
- **Judge** then reads it against the retrieved Canon and the brand's own
  fields, and has to cite a source for every violation it raises — `law`,
  `canon:<chunk_id>`, or `brand:<field>`. A violation it cannot source is
  dropped.

Say the line out loud while it runs: *the input was English marketing fluff
with two invented numbers; the output is Arabic he could post today, and it
had to earn its own pass.*

**This leg needs a live model key.** The FAIL leg cannot flake — it is
arithmetic. This one can be slow, and with no provider key it does not run at
all. `demo:check` gates it: if **Model provider key** is red, rehearse the FAIL
leg only and show the recorded run for the rewrite.

---

## OPTIONAL BEAT — THE AGENT THAT ADMITS IT WAS WRONG

**For an agency audience only. Cut it for everyone else, and cut it first.**
The WOW above does not change and does not move.

Agencies have seen dashboards refuse a hex code. What they have not seen is a
system that wrote down what it expected to happen, came back on a date it set
itself, and recorded that it was wrong. That is the beat: open **`/digest`** on
a week whose corrections lead, then click through to **`/decisions`**.

What to show, in this order:

1. **The digest, on the correction.** Not the wins. Read the correction aloud
   and let it sit.
2. **Click into `/decisions`.** Expand the refuted row. Show `basis` — the
   source keys the context blocks emitted and the values they rendered,
   verbatim. Those strings are printed exactly as stored, never re-rounded, so
   they match the block line character for character.
3. **Point at `cap` and `kill_condition`.** The ceiling the decision was given
   and the observable that would end it early — both written *before* the
   result was known, both real columns, not prose parsed back out of a
   sentence.
4. **Say the line:** *it set its own review date, it came back on it, and it
   recorded a refutation against the evidence it originally cited.*

Three properties are worth naming while the row is open, because each one is
enforced in code and an agency will ask:

- **There is no path back to `open`.** A recorded verdict cannot be quietly
  withdrawn. The update is scoped to open rows, so a decision judged between
  the page load and the click is left exactly as it was judged and the caller
  is told.
- **A verdict requires a note.** A status with no reason is not a review.
- **Nothing here marks a digest as sent.** There is no code path that writes
  that flag. Sending the digest to the client is a human act performed outside
  this product, and the column exists so a person can record it by hand.

**Say plainly what is not automated.** The verdict is a human act — the
operator reads what actually happened and records it. The system's contribution
is that it makes the question unavoidable: a decision nobody judged stays open,
stays visible, and shows up past-due. If you are asked whether corrections are
*forced* to lead the digest: they are not. Nothing in the code reads the order
of the digest text today. Say so — it is a smaller admission than the one the
beat is built on.

**Staging this beat is the hard part, and today it is not staged.**
`demo:check` reports **Digest exists** red and the decision ledger empty: no
digest has ever been run against this database, so there is no refuted decision
to open. A refuted decision cannot be manufactured for a demo without
fabricating the history that produced it — which is the one thing this whole
product exists not to do. Either run the strategist far enough ahead that a
review date genuinely arrives and a real verdict gets recorded, or cut the
beat. Do not stage it with invented rows.

If the slot is short, this beat is the first thing to go after Audience.

---

## THE SPINE

1. **Problem, live** — Dashboard. Personal averages **508** per post, academy
   **40**. His own voice outperforms the brand account roughly **13×**. Read
   from 320 real rows, not a slide.
2. **Workflow** — The Board. Open the 33,176-engagement card
   («الموضوع مش نكد»). Generate a concept and a storyboard from it, in Arabic,
   live. Audience, if the slot allows: who is in the comments and when they
   show up.
3. **WOW** — Compliance. Fail → Arabic rewrite → pass.
4. **So-what** — «كل رقم إله مصدر» — every claim traceable to a row.

---

## CLICK SCRIPT

Rehearse this ten times. Exact clicks, exact values.

| # | Screen | Action | Input |
|---|---|---|---|
| 1 | `/dashboard` | Point at the two averages | — |
| 2 | `/board` | Sort is already engagement-desc; open the top card | — |
| 3 | `/board` | Read the cluster label and explanation aloud | — |
| 4 | `/audience` | Read two recurring themes and one question aloud | — |
| 5 | `/audience` | Scroll to **Posting time × engagement**; point at the `n` on every window | — |
| 6 | `/concepts` | Count `3`, account `academy`, no theme → **Generate** | count: 3 |
| 7 | `/concepts` | Open the first card → **Storyboard** tab → **Generate** | frames: 5 |
| 8 | `/concepts` | Show the filming sheet print view | — |
| 9 | `/compliance` | Paste the off-brand text → **Check** | (text above) |
| 10 | `/compliance` | Expand two Law rows — show the evidence | — |
| 11 | `/compliance` | **Apply fixes & re-check** → read the Arabic rewrite aloud → PASS | — |
| 12 | `/guideline` | Show v1, scroll to Colour, point at the source tags | — |

Land on step 12 and stop.

Steps 4–5 are the only optional ones, and the first to cut. If you keep them,
the point of step 5 is not the heatmap — it is that no window is shown without
its `n`, because the model is forbidden from writing a timing number at all.
Those figures are arithmetic over `posted_at × engagement` in Amman time. The
model is allowed to name the shape of the pattern in Arabic and nothing else;
a digit in that field is rejected before it is stored.

---

## STAGING

- [ ] All 320 posts analysed (`/board` reads complete)
- [ ] Guideline v1 generated **and approved**
- [ ] A concept batch already generated, so a slow live run has a fallback
- [ ] One compliance check already in history
- [ ] Comments scraped **and** `/audience` generated — the Audience screen has
      no empty state worth showing, only a pointer back to Data
- [ ] A profile snapshot taken within the last week, or followers read as an
      em-dash on the Dashboard. The post export does not carry them; the
      profile scrape is their only source
- [ ] `IG_HANDLE_PERSONAL` and `IG_HANDLE_ACADEMY` set, and matching the
      handles the stored posts actually came from — a mismatch means the
      monitor is watching nobody
- [ ] `APIFY_BUDGET_USD` set to a real ceiling. Blank is not a ceiling, it is
      no ceiling: every scrape that can be costed is waved through
- [ ] A provider key `demo:check` reports green — without one, the Arabic
      rewrite leg cannot run and the WOW is half a demo
- [ ] No decision past its review date without a verdict. `demo:check` reports
      this against Amman's date, the same date `/decisions` computes it from.
      An overdue unanswered row is the worst thing to walk into live
- [ ] **Only if you are running the optional agency beat:** a digest exists and
      a decision has genuinely been reviewed and refuted. `demo:check` reports
      **Digest exists** and the ledger state. Do not fabricate either
- [ ] **Only if you are demoing the MCP endpoint:** `MCP_ACCESS_TOKEN` bound.
      `demo:check` proves the door refuses an unauthenticated call *and*
      answers `tools/list` with the configured token. Unset means the endpoint
      refuses everything, including your demo — check the daily generation cap
      has room left in the Amman day before you rely on a live MCP call
- [ ] `npm run demo:check` fully green
- [ ] Do Not Disturb on, notifications off, clean browser profile
- [ ] Font zoom 110–125% — Arabic at default size does not read from the back
      of a room
- [ ] Dev server already warm: visit every demo screen once before they walk in

---

## BACKUP

**Record one clean run to local storage before any live demo.** Not cloud —
venue wifi is the thing most likely to fail.

In a hostile venue (bad wifi, no control of the network, a slot under five
minutes) the recording is the default and the live run is the encore. Live
earns itself; it is not owed a slot.

---

## FAILURE DRILLS

| Break | Do this | Say this |
|---|---|---|
| No network | Switch to the recording | "I have a recording — same run, made this morning." |
| Model slow (>8s) | Show the cached concept batch | "That one's cached from earlier — the live call is still going, we'll come back to it." |
| The Arabic rewrite stalls or errors | Stay on the FAIL screen, read the Law evidence | "The refusal is the deterministic half and it already ran — no model involved. The rewrite is the model, and it's still thinking." |
| Bad or weird output | Keep it on screen; open Compliance on it | "Good — let's run that through the checker. This is exactly what it's for." |
| Compliance unexpectedly passes | Show the Law rows anyway | "The checks ran and cleared it — here's the evidence it used." |
| A screen errors | Move to the next step, come back if time | Do not debug in front of the room. |

The fourth row is the strongest position in the demo: a bad output is not a
failure of the product, it is the product's use case.

---

## TIMING

**Four minutes for a five-minute slot.** Never fill the slot.

- Problem: 40s
- Board + generate: 90s
- WOW: 90s
- Landing: 20s

Audience (steps 4–5) is not in that budget. It is the one optional stretch in
the script — add it only when the slot is genuinely six minutes or more.

**The 60-second compressed path**, when the slot collapses: Dashboard averages
(15s) → Compliance fail → fix → pass (35s) → the so-what line (10s). Skip the
Board, skip Audience, skip generation, skip the guideline.

---

## THE LANDING

> "Every claim in here traces back to a row in his own data. The system will
> refuse to ship work it cannot source — كل رقم إله مصدر."

Then stop talking. Do not tour the remaining features.
