# Phase-Balancing Copilot · dry-run simulator

A standalone web app that walks through the **Panel Schedule & Phase-Balancing Copilot** concept on a sample building. It shows every step of the concept: audit every panel, search for the fewest circuit moves, propose, review, apply and report. There is no Revit connection, no API and no plugin. The optimisation core is a line-for-line JavaScript port of the Python reference in §10 of the concept document, and the tests prove the two give identical answers.

## Run it

- **Easiest:** double-click `index.html`. It works offline. Fonts fall back to system fonts without internet.
- **One file to share:** `dist/phase-balancer-copilot.html` has everything inlined. Email it or put it on any static host.
- **Rebuild the single file** after editing: `npm run build`
- **Run the tests:** `npm test`. You need Node 18 or later. The parity test also needs `python3`.

## Presenting it

1. Press **Guided dry run** in the top bar. Eleven scenes tell the story from an unaudited model to the QA log.
2. Use **→ / ←** or the Next and Back buttons, **Esc** to leave, and **Auto-play** for a hands-free loop of about 10 seconds per scene.
3. Press **Explore freely** at any point to take questions live. The model stays in the state the scene left it in.

Deep links jump straight into a state, which helps if a meeting runs short:

| Link suffix | Opens |
|---|---|
| `#scene=5` | The LP-2A proposal with the breaker animation |
| `#scene=6` | Minimum moves against fresh layout (LPT) |
| `#scene=7` | Locking a circuit and watching the copilot work around it |
| `#scene=11` | Report, KPIs and CSV |
| `&presenter=off` | Hides the presenter strip |
| `&theme=dark` | Forces the dark theme |

## What is on screen

| View | What it shows |
|---|---|
| **Project audit** | Riser diagram of 12 panels across five levels, a before/after imbalance chart and a sortable audit table with accept and reject per panel. |
| **Panel workspace** | The physical panelboard with A-B-C bus bars, breakers by slot, 1-, 2- and 3-pole breakers, spares, spaces and padlocks. It also shows phase loading against the target band, a neutral-current phasor, the review dialog in the §12 style, the search trace and a plain-language summary. |
| **Approach comparison** | As drawn, fresh layout (LPT) and minimum moves side by side, with circuits renumbered and the issued sheets touched. |
| **Report & log** | Pilot KPIs O1 to O5, undoable transactions, the §13.1 change log and the CSV. |
| **Rules & config** | Live `config.json`, the R1 to R9 rules and how each is enforced, the T1 to T9 self-test and the §18 assumptions checklist. |

Things to try live:

- **Lock a circuit.** Click a padlock on a breaker and the copilot re-runs around it.
- **Change the target.** Drag the target slider and re-run.
- **Change the basis.** Switch between connected and demand VA.
- **Simulate drift.** Press "Simulate design change" to make a load drift, then re-run the audit to see it flagged.

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
