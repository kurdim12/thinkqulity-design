# DEMO

Run `npm run demo:check` first. Red means do not demo.

---

## THE WOW

Paste Ahmad's own off-brand draft into **Compliance** → instant **FAIL** with
receipts: the exact hex that is not in his palette, and the register score
measured against his real captions → click **Apply fixes** → **PASS**.

One moment, interactive, unfakeable. The audience watches a machine refuse to
approve work — which is the opposite of what they expect an AI demo to do, and
the reason they will remember it.

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

---

## THE SPINE

1. **Problem, live** — Dashboard. Personal averages **508** per post, academy
   **40**. His own voice outperforms the brand account roughly **13×**. Read
   from 320 real rows, not a slide.
2. **Workflow** — The Board. Open the 33,176-engagement card
   («الموضوع مش نكد»). Generate a concept and a storyboard from it, in Arabic,
   live.
3. **WOW** — Compliance. Fail → fix → pass.
4. **So-what** — «كل رقم إله مصدر» — every claim traceable to a row.

---

## CLICK SCRIPT

Rehearse this ten times. Exact clicks, exact values.

| # | Screen | Action | Input |
|---|---|---|---|
| 1 | `/dashboard` | Point at the two averages | — |
| 2 | `/board` | Sort is already engagement-desc; open the top card | — |
| 3 | `/board` | Read the cluster label and explanation aloud | — |
| 4 | `/concepts` | Count `3`, account `academy`, no theme → **Generate** | count: 3 |
| 5 | `/concepts` | Open the first card → **Storyboard** tab → **Generate** | frames: 5 |
| 6 | `/concepts` | Show the filming sheet print view | — |
| 7 | `/compliance` | Paste the off-brand text → **Check** | (text above) |
| 8 | `/compliance` | Expand two Law rows — show the evidence | — |
| 9 | `/compliance` | **Apply fixes & re-check** → PASS | — |
| 10 | `/guideline` | Show v1, scroll to Colour, point at the source tags | — |

Land on step 10 and stop.

---

## STAGING

- [ ] All 320 posts analysed (`/board` reads complete)
- [ ] Guideline v1 generated **and approved**
- [ ] A concept batch already generated, so a slow live run has a fallback
- [ ] One compliance check already in history
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
| Bad or weird output | Keep it on screen; open Compliance on it | "Good — let's run that through the checker. This is exactly what it's for." |
| Compliance unexpectedly passes | Show the Law rows anyway | "The checks ran and cleared it — here's the evidence it used." |
| A screen errors | Move to the next step, come back if time | Do not debug in front of the room. |

The third row is the strongest position in the demo: a bad output is not a
failure of the product, it is the product's use case.

---

## TIMING

**Four minutes for a five-minute slot.** Never fill the slot.

- Problem: 40s
- Board + generate: 90s
- WOW: 90s
- Landing: 20s

**The 60-second compressed path**, when the slot collapses: Dashboard averages
(15s) → Compliance fail → fix → pass (35s) → the so-what line (10s). Skip the
Board, skip generation, skip the guideline.

---

## THE LANDING

> "Every claim in here traces back to a row in his own data. The system will
> refuse to ship work it cannot source — كل رقم إله مصدر."

Then stop talking. Do not tour the remaining features.
