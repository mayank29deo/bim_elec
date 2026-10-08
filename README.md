# Phase-Balancing Copilot · dry-run simulator

A standalone web app that walks through the **Panel Schedule & Phase-Balancing Copilot** concept on a sample building. It shows every step of the concept: audit every panel, search for the fewest circuit moves, propose, review, apply and report. There is no Revit connection, no API and no plugin. The optimisation core is a line-for-line JavaScript port of the Python reference in §10 of the concept document, and the tests prove the two give identical answers.

## Run it

- **Easiest:** double-click `index.html`. It works offline. Fonts fall back to system fonts without internet.
- **One file to share:** `dist/phase-balancer-copilot.html` has everything inlined. Email it or put it on any static host.
- **Rebuild the single file** after editing: `npm run build`
- **Run the tests:** `npm test`. You need Node 18 or later. The parity test also needs `python3`.

## Presenting it

1. Press **Guided dry run** (the play button on a phone). Eleven scenes tell the story from an unaudited model to the QA log.
2. Use **→ / ←** or Next and Back, **Esc** or Exit to leave, and **Auto-play** for a hands-free loop of about 10 seconds per scene.
3. Press **Exit** at any point to take questions live. The model stays in the state the scene left it in.

For someone new to the topic, the **?** button shows a three-line explainer of phase balancing. On the audit screen, the **Next step** bar always shows the one action to take: Run audit, then Find fixes, Accept, Apply, and finally the report.

Deep links jump straight into a state, which helps if a meeting runs short:

| Link suffix | Opens |
|---|---|
| `#scene=5` | The LP-2A fix with the breaker animation |
| `#scene=6` | Fewest moves against a fresh layout |
| `#scene=7` | Locking a circuit and watching the copilot work around it |
| `#scene=11` | Report and pilot measures |
| `&presenter=off` | Hides the presenter strip |
| `&intro=off` | Hides the explainer |
| `&theme=dark` | Forces the dark theme |

## What is on screen

Every screen shows the essentials first. Engineering detail sits in sections that open on demand, such as the search steps, neutral current, the full numbers table and the CSV.

| Screen | What it shows |
|---|---|
| **Audit** | The next step, three headline counts, a riser diagram of 12 panels across five levels, and a "Panels to look at" list where each panel is described in one sentence with Accept and Reject buttons. |
| **Panel** | A plain-language status line, one "Find the fewest moves" button and a target slider. It shows the panelboard with A-B-C bus bars, locks, spares and spaces, a balance card with the three phases against the target band, and the proposed fix written as a list of moves. |
| **Compare** | As drawn, a fresh layout and fewest moves side by side, with how many circuits each renumbers. |
| **Report** | Pilot measures O1 to O5, every decision, undoable model changes, the CSV export and the activity log. |
| **Settings** | The main firm settings, more settings and `config.json` on demand, the T1 to T9 self-test, rules R1 to R9 and the §18 questions checklist. |

**On a phone,** navigation moves to a bottom bar and a dropdown replaces the panel list. The panelboard shrinks to fit the screen, showing circuit numbers and loads, and you tap a breaker to see its name. Nothing scrolls sideways.

Things to try live:

- **Lock a circuit.** Tap a padlock on a breaker and the copilot re-runs around it.
- **Change the target.** Drag the target slider, then press Find the fewest moves.
- **Change the basis.** Open More options to switch between connected and demand load.
- **Simulate drift.** Use "Simulate a design change", then re-run the audit to see it flagged.

## Sample panels

| Panel | What it demonstrates |
|---|---|
| LP-2A | The §9 worked example: 23.1% → 2.6% by moving one circuit. LPT moves five. |
| RP-2B | Phase C has no free slots, so only swaps reach C (T7). |
| PP-1A | Mixed 1-, 2- and 3-pole circuits. The move lands in a spare slot and the spare is relocated (R2, R7). |
| LP-3C | Two DoNotMove circuits. The copilot balances around them. |
| PP-3A | One 3.7 kVA single-pole load. The target is unreachable, so the panel is flagged "Needs engineer" with the best achievable %. |
| LP-4A | Locked circuits block the fix. The panel is flagged "Locked-limited" with what is reachable without the locks. |
| MP-1 | Only 3-pole loads, so 0% and nothing moves (T5). |
| LP-3B | Within target, but one circuit has no load set. The audit flags it. |

All panel data is fictional sample data.

## Files

```
index.html                  page shell and styles
src/phase_balancer.js       core: port of reference/phase_balancer.py (no DOM, runs in Node too)
src/panel_model.js          simulated Revit layer: slot→phase rule, locks, demand basis, slot mapping, read-back check
src/sample_project.js       the 12 sample panels
src/app.js                  UI, guided dry run, in-browser self-test
reference/phase_balancer.py the §10 Python, as in concept note v1.1
docs/concept-note.md        the concept document, version 1.1
tests/core.test.js          T1–T9, slot mapping, and JS-vs-Python parity on 300 random panels
scripts/build.mjs           bundles everything into dist/phase-balancer-copilot.html
```

## Simulated or assumed

- **Slot mapping (§11.4).** A move takes the lowest-numbered free slot on the new phase, and a swap exchanges slots. Afterwards the loads are re-read and must match the core's prediction within ±1 VA.
- **Neutral current.** It is estimated from single-pole loads at unity power factor, at the selected line-to-neutral voltage.
- **Demand factors.** Lighting 1.0, receptacles 0.8, equipment 0.75 and mechanical 1.0 are placeholders until the project standard is confirmed.
- **Engineer minutes per panel (O4).** This is not measured in a dry run. It belongs to pilot week 1.
- **Plain-language summary.** A fixed template writes it. No LLM is called.

## Concept note

`docs/concept-note.md` is the concept document at version 1.1. It fixes three inconsistencies found while building the simulator, and its §21 lists the changes:

1. **Worked example numbering.** Circuit numbers now equal slot numbers, as §1.1 requires. The minimum-move fix reads "Ckt 13 → slot 6 (A → C)" everywhere: in the document, the reference Python, the tests and the simulator. Version 1.0 said "slot 9 (C)", but slot 9 feeds phase B.
2. **Sample LLM explanation.** It now says phase A carries two of the four largest loads, not three.
3. **IronPython note.** It now lists every change the IronPython 2.7 engine needs: the dataclass, `dataclasses.replace` and the type annotations.

The balance figures are unchanged: 23.1% → 2.6%, with one circuit renumbered against five for LPT.
