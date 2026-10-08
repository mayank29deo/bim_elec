# Panel Schedule & Phase-Balancing Copilot

**Reference document · AI × Electrical BIM case study**
Author: Mayank, Executive Electrical Engineer (BIM) · Version 1.1 · October 2026
Status: Concept / pilot proposal

---

## 0. TL;DR

| | |
|---|---|
| **Problem** | Circuits are placed on panel phases by hand. When loads change during design, panels drift out of balance, and fixing them means manual trial-and-error that also renumbers circuits already shown on drawings. |
| **Solution** | A Revit add-in (pyRevit button) that audits every panel in the model, flags imbalance above a firm threshold, and proposes the **fewest circuit moves** that bring each panel back within limits. The engineer reviews a change list and applies it in one undoable transaction. |
| **Why it matters** | Faster QA, consistent results across engineers, fewer late revisions, and an auditable record of balance on every issue. |
| **Effort** | Low. The pure-Python core is about 150 lines, the Revit wrapper is about 300. Pilot in 4 weeks. |
| **"AI" angle** | Combinatorial optimisation (search over circuit-to-phase assignments) does the decision work. An optional LLM layer explains the change set in plain language. Every number comes from deterministic logic, never from an LLM. |

---

## 1. Background: how phase loading works in a panel

### 1.1 Slots map to phases

A 3-phase, 4-wire panelboard has its slots fed by bus bars in a fixed A-B-C sequence. In the standard two-column layout (odd circuits on the left, even on the right):

| Row | Left slot | Right slot | Phase |
|---|---|---|---|
| 1 | 1 | 2 | A |
| 2 | 3 | 4 | B |
| 3 | 5 | 6 | C |
| 4 | 7 | 8 | A |
| … | … | … | repeats |

A circuit's **phase is determined by its slot position**. So "balancing a panel" in practice means **moving circuits between slots**, which **changes their circuit numbers**.

### 1.2 Pole count

| Circuit type | Slots used | Phase contribution |
|---|---|---|
| 1-pole (L-N), e.g. 230/277 V lighting, receptacles | 1 | Full load on one phase |
| 2-pole (L-L), e.g. 208/400 V single-phase equipment | 2 consecutive rows | Load split equally across the two phases |
| 3-pole, e.g. 3Φ motors, AHUs, chillers | 3 consecutive rows | Load split equally across A, B and C, so it is inherently balanced |

**Only 1-pole circuits create imbalance**, and only they need to be moved. Multi-pole circuits are treated as fixed contributions.

### 1.3 Measuring imbalance

The firm-configurable metric used throughout this document:

```
L_avg        = (L_A + L_B + L_C) / 3
Imbalance %  = max(|L_A − L_avg|, |L_B − L_avg|, |L_C − L_avg|) / L_avg × 100
```

Typical design targets sit around **≤ 10%**, with some firms or clients using 5% or 15%. The threshold is a configuration value, not something hard-coded.

> **Assumption:** the balance is calculated on **connected load (VA)** by default, with an option to switch to **demand load** once demand factors per load classification are applied. Confirm which basis your project standards use.

---

## 2. Problem statement

### 2.1 Statement

> Electrical BIM engineers assign circuits to panel phases manually. As loads change through design development and coordination, panels drift out of balance without anyone noticing. Detecting and correcting that drift is slow, inconsistent between engineers, and disruptive, because each correction renumbers circuits that are already tagged on issued drawings.
>
> **How might we automatically detect phase imbalance across every panel in a model and propose the smallest set of circuit moves that restores balance, while keeping the engineer in full control of what is applied?**

### 2.2 Symptoms on live projects

- Panel schedules show phase totals that differ by 20% or more, and are only caught at QA or by the reviewing consultant.
- Engineers re-shuffle circuits by trial and error in the panel schedule view, one panel at a time.
- Re-balancing late in the project renumbers many circuits, which breaks circuit tags, homerun annotations and the cross-references between the panel schedule and the floor plans.
- Two engineers balancing the same panel produce different layouts, so there is no repeatable standard.
- There is no project-wide view that answers "which panels are out of balance right now?"

### 2.3 Root causes

| Root cause | Effect |
|---|---|
| Circuits are created in modelling order rather than load order | Large loads cluster on the same phase |
| Loads change after circuiting (equipment swaps, revised fixture wattages, added receptacles) | Balance degrades silently |
| No automated check in the QA workflow | Imbalance is found late |
| Manual fixes optimise for balance alone, not for minimum disruption | Too many circuits get renumbered |
| Each panel is fixed in isolation | No portfolio view, and no record of before and after |

### 2.4 Impact

- **Engineering:** unbalanced phases increase neutral current, cause uneven transformer and feeder loading, and can push the heaviest phase toward breaker and feeder limits.
- **Delivery:** extra QA cycles, consultant comments and revision churn on sheets that are already issued.
- **Cost:** hours of repetitive rework per panel, multiplied across dozens to hundreds of panels per project.

### 2.5 Who is affected

| Stakeholder | Pain |
|---|---|
| Electrical modeller | Manual shuffling, plus re-tagging after renumbering |
| Electrical lead / QA checker | Has to verify every panel by hand |
| Coordinator / BIM manager | No project-level status view |
| Client / consultant | Receives comments late, which affects confidence |

---

## 3. Current approach and its gaps

| Approach | Gap |
|---|---|
| Manual drag-and-drop in the panel schedule view | Slow, trial and error, not repeatable |
| Revit's built-in **Rebalance Loads** in panel schedule editing | Works one panel at a time. It does not optimise for *minimum renumbering*, provides no project-wide audit, no threshold-driven report and no before/after record. *(Assumption: verify how it behaves with locked slots in your Revit version.)* |
| Excel load sheets kept outside Revit | Data duplicated, goes stale, needs manual sync back into the model |

**Positioning:** this tool does not reinvent balancing. It adds **audit, minimum-disruption optimisation, firm rules, reporting and traceability** on top of what Revit already offers.

---

## 4. Objectives and success metrics

| # | Objective | KPI | Target (pilot) |
|---|---|---|---|
| O1 | Detect imbalance early | % of panels audited automatically before each issue | 100% |
| O2 | Restore balance | Panels within threshold after the tool runs | ≥ 95% (others are flagged with a reason) |
| O3 | Minimise disruption | Average circuits renumbered per corrected panel | ≤ 3 |
| O4 | Save time | Engineer minutes per panel (audit and fix) | From ~15–20 to ≤ 3 *(baseline to be measured)* |
| O5 | Traceability | Panels with a logged before/after record | 100% |

> Baseline times are placeholders and must be measured in week 1 of the pilot.

---

## 5. Scope

**In scope (v1)**
- 3-phase 4-wire panelboards in the active Revit model
- 1-pole circuits as movable items; 2- and 3-pole circuits as fixed contributions
- Locked slots and engineer "do-not-move" flags respected
- Project-wide audit, per-panel proposals, review dialog, apply in a single transaction, CSV report

**Out of scope (v1)**
- Single-phase panels (nothing to balance)
- Moving circuits *between* panels
- Feeder- or transformer-level balancing across multiple panels (planned for v2)
- Breaker and wire resizing (handled by the voltage-drop and cable-sizing validator idea)

---

## 6. Solution overview

### 6.1 Concept

A **copilot** that follows five steps:

```
 ┌──────────┐   ┌───────────┐   ┌────────────┐   ┌──────────────┐   ┌─────────┐
 │ 1 AUDIT  │──▶│ 2 OPTIMISE│──▶│ 3 PROPOSE  │──▶│ 4 ENGINEER   │──▶│ 5 APPLY │
 │ all      │   │ min-move  │   │ change list│   │   REVIEW     │   │ + REPORT│
 │ panels   │   │ search    │   │ + metrics  │   │ accept/reject│   │ 1 txn   │
 └──────────┘   └───────────┘   └────────────┘   └──────────────┘   └─────────┘
```

1. **Audit:** read every panel and its circuits, compute phase loads and imbalance, and flag panels above the threshold.
2. **Optimise:** for each flagged panel, search for the smallest set of moves and swaps that brings imbalance under the target while respecting every constraint.
3. **Propose:** produce a change list (e.g. *"Ckt 13 → slot 6 (A → C)"*) with before and after metrics.
4. **Review:** the engineer accepts or rejects each panel's proposal, or adjusts the target and re-runs it.
5. **Apply and report:** write the accepted changes back in one named, undoable Revit transaction, and export a CSV and summary.

### 6.2 Where AI fits

| Layer | Technique | Role |
|---|---|---|
| Decision core | Combinatorial optimisation (greedy + local search; ILP optional) | Finds the assignment. Deterministic and explainable |
| Explanation (optional) | LLM | Turns the change list into a plain-language summary for reviewers, and answers "why did Ckt 13 move?" |
| Learning (v2) | Logged accept/reject decisions | Tunes default weights, e.g. how much an engineer prefers fewer moves over tighter balance |

**Rule:** an LLM never calculates loads or decides placements. It only explains decisions.

---

## 7. Engineering rules and constraints

| ID | Rule | Type |
|---|---|---|
| R1 | Only 1-pole, unlocked circuits are movable | Hard |
| R2 | Multi-pole circuits stay where they are, and their load is split equally across their phases | Hard |
| R3 | Engineer-locked slots and circuits flagged `DoNotMove = Yes` are never moved | Hard |
| R4 | The number of 1-pole circuits on a phase cannot exceed the free slots on that phase | Hard |
| R5 | Imbalance must be ≤ the target % (default 10%) | Goal |
| R6 | Minimise the number of circuits renumbered | Objective |
| R7 | Spares and spaces may be used as move targets; occupied slots change only through swaps | Hard |
| R8 | Optional: keep circuits from the same group (e.g. one lighting zone) together | Soft (v2) |
| R9 | Balance basis is connected VA (default) or demand VA (configurable) | Config |

---

## 8. Algorithm design

### 8.1 Notation

- `M` = movable circuits, each with load `w_i`
- `F_p` = fixed load on phase `p` from multi-pole and locked circuits
- `x_ip ∈ {0,1}` = 1 if circuit `i` is on phase `p`
- `x⁰_ip` = current (drawn) assignment
- `L_p = F_p + Σ_i w_i · x_ip`

### 8.2 Objective

Lexicographic: **first** meet the imbalance target, **then** minimise moves, **then** minimise the remaining imbalance.

```
minimise   λ · Σ_i Σ_p |x_ip − x⁰_ip| / 2   +   (L_max − L_min)
subject to Σ_p x_ip = 1                       ∀ i ∈ M
           Σ_i x_ip ≤ Slots_p                  ∀ p
           Imbalance% ≤ target
```

### 8.3 Approaches

| Approach | How it works | Pros | Cons | Use |
|---|---|---|---|---|
| **A. Greedy LPT** | Sort movable circuits by load, largest first; put each on the lightest phase | Very fast, near-optimal balance | Ignores the current layout, so it renumbers many circuits | Fresh panels with no drawings issued |
| **B. Min-move local search** *(default)* | Start from the drawn layout; repeatedly apply the single move or pairwise swap with the best imbalance reduction per circuit renumbered; stop at the target | Few renumbers, explainable step by step, pure Python | Not guaranteed globally optimal | Panels already on issued sheets |
| **C. Integer linear programme** | Solve §8.2 exactly with OR-Tools or PuLP | Provably optimal | Needs a CPython solver outside the Revit process | v2 / large panels |

Panels have at most a few dozen circuits, so approaches A and B run in milliseconds.

### 8.4 Pseudocode (approach B)

```
state ← drawn layout
while imbalance(state) > target:
    best ← none
    for each movable circuit c, each other phase p with a free slot:
        gain ← (imbalance(state) − imbalance(state with c on p)) / 1
    for each pair (a, b) of movable circuits on different phases:
        gain ← (imbalance(state) − imbalance(state with a, b swapped)) / 2
    best ← candidate with the highest positive gain
    if best is none: break            # target not reachable, so flag the panel
    apply best; record moved circuits
return state, moved circuits
```

---

## 9. Worked example

Panel LP-2A has nine single-pole circuits, drawn in modelling order down the left-hand column. They occupy odd slots 1 to 17, so by §1.1 their phases rotate A, B, C. As everywhere in this document, the circuit number is the slot number.

| Ckt (slot) | Load (VA) | Drawn phase |
|---|---|---|
| 1 | 2400 | A |
| 3 | 1800 | B |
| 5 | 1500 | C |
| 7 | 1500 | A |
| 9 | 1200 | B |
| 11 | 1000 | C |
| 13 | 900 | A |
| 15 | 800 | B |
| 17 | 600 | C |

Total = 11,700 VA, so L_avg = 3,900 VA.

| Scenario | L_A | L_B | L_C | Imbalance | Circuits renumbered |
|---|---|---|---|---|---|
| As drawn | 4800 | 3800 | 3100 | **23.1%** | – |
| Greedy LPT (A) | 4000 | 3900 | 3800 | 2.6% | **5** (Ckts 7, 11, 13, 15, 17) |
| Min-move search (B) | 3900 | 3800 | 4000 | 2.6% | **1** (Ckt 13: A → C, into free slot 6, new no. 6) |

**The takeaway for the pitch:** both approaches reach the same balance, but the min-move search gets there by renumbering **one** circuit instead of five. That is the difference between a 2-minute fix and a re-tagging exercise across several sheets.

*(These figures are produced by the reference implementation in §10. The slot for the move comes from the §11.4 rule: the lowest-numbered free slot on phase C.)*

---

## 10. Reference implementation (pure Python core)

The core has no Revit dependency, so it can be unit-tested anywhere and reused in the web demo, a CLI or the pyRevit button.

```python
# phase_balancer.py
from dataclasses import dataclass, replace
from itertools import combinations

PHASES = ("A", "B", "C")


@dataclass(frozen=True)
class Circuit:
    number: int              # circuit number in the panel schedule
    load_va: float           # apparent load (connected or demand, per config)
    phases: tuple            # e.g. ("A",) for 1-pole, ("A","B") for 2-pole
    locked: bool = False     # engineer-locked slot, never moved

    @property
    def movable(self) -> bool:
        return len(self.phases) == 1 and not self.locked


def phase_loads(circuits):
    loads = {p: 0.0 for p in PHASES}
    for c in circuits:
        share = c.load_va / len(c.phases)   # multi-pole load splits equally
        for p in c.phases:
            loads[p] += share
    return loads


def imbalance_pct(loads):
    avg = sum(loads.values()) / 3
    if avg == 0:
        return 0.0
    return max(abs(v - avg) for v in loads.values()) / avg * 100


def lpt_balance(circuits):
    """Greedy Longest-Processing-Time: biggest movable load to lightest phase.
    Ignores current positions, so it usually moves many circuits."""
    fixed = [c for c in circuits if not c.movable]
    movable = sorted((c for c in circuits if c.movable), key=lambda c: -c.load_va)
    loads = phase_loads(fixed)
    result = list(fixed)
    for c in movable:
        p = min(PHASES, key=lambda q: loads[q])
        loads[p] += c.load_va
        result.append(replace(c, phases=(p,)))
    return sorted(result, key=lambda c: c.number)


def min_move_balance(circuits, target_pct=5.0, slot_capacity=None, max_iter=50):
    """Local search starting from the drawn layout. Each step applies the single
    move or pairwise swap that cuts imbalance the most per circuit renumbered,
    and stops once the target is met or nothing improves."""
    cur = {c.number: c for c in circuits}
    moved = set()

    def count_on(phase, state):
        return sum(1 for c in state.values() if c.movable and c.phases == (phase,))

    for _ in range(max_iter):
        loads = phase_loads(cur.values())
        base = imbalance_pct(loads)
        if base <= target_pct:
            break
        best = None  # (gain_per_circuit, new_state, touched)
        movables = [c for c in cur.values() if c.movable]
        # single moves
        for c in movables:
            for p in PHASES:
                if p == c.phases[0]:
                    continue
                if slot_capacity and count_on(p, cur) >= slot_capacity[p]:
                    continue
                trial = dict(cur)
                trial[c.number] = replace(c, phases=(p,))
                gain = base - imbalance_pct(phase_loads(trial.values()))
                if gain > 1e-9 and (best is None or gain > best[0]):
                    best = (gain, trial, {c.number})
        # swaps (keep slot counts unchanged)
        for a, b in combinations(movables, 2):
            if a.phases == b.phases:
                continue
            trial = dict(cur)
            trial[a.number] = replace(a, phases=b.phases)
            trial[b.number] = replace(b, phases=a.phases)
            gain = (base - imbalance_pct(phase_loads(trial.values()))) / 2
            if gain > 1e-9 and (best is None or gain > best[0]):
                best = (gain, trial, {a.number, b.number})
        if best is None:
            break
        cur = best[1]
        moved |= best[2]

    original = {c.number: c.phases for c in circuits}
    moved = {n for n in moved if cur[n].phases != original[n]}
    return sorted(cur.values(), key=lambda c: c.number), moved


if __name__ == "__main__":
    # §9 worked example: nine 1-pole circuits drawn in modelling order down the
    # left-hand column, so they sit in odd slots 1, 3, ... 17 and their phases
    # rotate A, B, C (§1.1). Circuit number = slot number.
    loads = [2400, 1800, 1500, 1500, 1200, 1000, 900, 800, 600]
    drawn = [Circuit(2 * i + 1, va, (PHASES[i % 3],)) for i, va in enumerate(loads)]
    for name, res in [("drawn", drawn), ("lpt", lpt_balance(drawn))]:
        L = phase_loads(res)
        moved = [c.number for c, d in zip(res, drawn) if c.phases != d.phases]
        print(name, L, round(imbalance_pct(L), 1), "moved", moved)
    res, moved = min_move_balance(drawn, target_pct=5)
    L = phase_loads(res)
    print("minmove", L, round(imbalance_pct(L), 1), "moved", sorted(moved))
```

Expected output:

```
drawn {'A': 4800.0, 'B': 3800.0, 'C': 3100.0} 23.1 moved []
lpt {'A': 4000.0, 'B': 3900.0, 'C': 3800.0} 2.6 moved [7, 11, 13, 15, 17]
minmove {'A': 3900.0, 'B': 3800.0, 'C': 4000.0} 2.6 moved [13]
```

**Notes**
- The core deliberately has no third-party imports. pyRevit's CPython engine (Python 3.7 or later) runs it unchanged.
- For pyRevit's IronPython 2.7 engine, the listing needs three small changes because it uses Python 3 syntax: replace the dataclass with a plain class, replace `dataclasses.replace` with a small copy helper, and remove the type annotations (`number: int`, `-> bool`).
- The core decides phases. The Revit layer (§11) translates "phase X" into a concrete free slot or swap partner.

---

## 11. Revit integration design

### 11.1 Delivery vehicle

A **pyRevit extension** with one ribbon panel:

```
PhaseBalancer.extension/
└── PhaseBalancer.tab/
    └── Electrical.panel/
        ├── AuditPanels.pushbutton/      # project-wide audit → report
        │   └── script.py
        ├── BalancePanel.pushbutton/     # selected panel → propose → apply
        │   └── script.py
        └── lib/
            ├── phase_balancer.py        # core from §10 (no Revit imports)
            ├── revit_io.py              # read/write panels & circuits
            └── config.json              # thresholds, basis, weights
```

A C# add-in is the production-hardening option later (better performance, deployment through the firm's add-in manager).

### 11.2 Revit API touchpoints

> **Assumption:** class and member names below are from the `Autodesk.Revit.DB.Electrical` namespace as I understand it. Verify each one against the API documentation for your Revit version (revitapidocs.com) before coding.

| Need | API element |
|---|---|
| Find panels | `FilteredElementCollector` → `FamilyInstance` in `OST_ElectricalEquipment` that have a `MEPModel` with assigned circuits |
| Read circuits on a panel | `ElectricalSystem` elements (`BaseEquipment` = panel): `CircuitNumber`, `PolesNumber`, `ApparentLoad`, `StartSlot`, `LoadName` |
| Panel schedule view | `PanelScheduleView` (`GetTableData`, `GetCircuitIdByCell`, `IsSlotLocked`) |
| Move circuits between slots | `PanelScheduleView.CanMoveSlotTo(...)` → `MoveSlotTo(...)` |
| Phase totals for checking | Panel parameters for apparent load per phase (e.g. `RBS_ELEC_APPARENT_LOAD_PHASEA/B/C`) |
| Safe write | One `Transaction` named "Phase Balancer – <Panel>" per apply (or a `TransactionGroup` for a batch) |

### 11.3 Process flow

```
[Button] Balance Panel
  │
  ├─ Read selected panel → list[Circuit] (number, VA, phases, locked)
  ├─ Read free slots per phase → slot_capacity
  ├─ Core: min_move_balance(circuits, target, slot_capacity)
  │     └─ if target not reached → status "Needs engineer" + reason
  ├─ Map phase changes → slot moves (prefer free slot on target phase, else swap)
  ├─ Verify every move with CanMoveSlotTo; drop and flag any that fail
  ├─ Show review dialog (before/after table + change list)
  │     ├─ Accept → Transaction: MoveSlotTo for each → commit
  │     └─ Reject → no change
  └─ Append row to project log CSV
```

### 11.4 Mapping phases to slots

1. For a **single move** to phase *p*: choose the lowest-numbered free slot whose row feeds *p*. This keeps the panel compact.
2. For a **swap**: exchange the two circuits' slots directly.
3. After applying, **re-read** the phase loads from Revit and assert that they match the core's prediction within ±1 VA. If they don't, roll back and flag the panel.

---

## 12. User experience

**Audit Panels (project-wide)**
- One click, then a summary dialog: *"42 panels checked · 9 above 10% · worst: LP-3C at 27%"*.
- Sortable table: Panel | Level | L_A | L_B | L_C | Imbalance % | Status (OK / Over / Locked-limited).
- Export to CSV for the QA record.

**Balance Panel (single or batch)**
- Inputs: target % (default from config) and approach (min-move / fresh-layout LPT).
- The review dialog shows:
  - Before → after phase bars and imbalance %
  - Change list: `Ckt 13  "Receptacles – Bay 3"  900 VA  slot 13 (A) → slot 6 (C)  new no. 6`
  - Warning if any moved circuit is tagged on a sheet that has already been issued
- Buttons: **Apply**, **Cancel**, **Re-run with a different target**.

**Optional LLM explanation** (behind a firm-approved model, opt-in)
> "LP-2A was 23.1% unbalanced. Phase A carried 4,800 VA against a 3,900 VA average, including the largest single load on the panel (2,400 VA). Moving one 900 VA receptacle circuit, Ckt 13, from A to C brings every phase within 2.6% of the average. No other circuits change."

---

## 13. Outputs

### 13.1 Audit / change log (CSV)

| Column | Example |
|---|---|
| timestamp | 2026-10-08T20:15 |
| project | <project number> |
| panel | LP-2A |
| basis | connected |
| LA_before / LB_before / LC_before | 4800 / 3800 / 3100 |
| imbalance_before_pct | 23.1 |
| LA_after / LB_after / LC_after | 3900 / 3800 / 4000 |
| imbalance_after_pct | 2.6 |
| circuits_moved | 1 |
| changes | 13:A→C(slot 13→6) |
| status | Applied / Rejected / Needs engineer |
| engineer | <Revit username> |

### 13.2 Config (`config.json`)

```json
{
  "imbalance_target_pct": 10,
  "balance_basis": "connected",
  "default_approach": "min_move",
  "max_moves_per_panel": 6,
  "respect_locked_slots": true,
  "do_not_move_parameter": "DoNotMove",
  "log_path": "./phase_balancer_log.csv"
}
```

---

## 14. Web demo (dry-run simulator)

A standalone web simulator runs the whole copilot flow on a 12-panel sample model, with no Revit connection and no API. It opens in any browser. Its core is a line-for-line JavaScript port of §10, and an automated test checks that it gives the same results as the Python on 300 random panels.

| Feature | Where it appears in the simulator |
|---|---|
| Load the §9 example | Panel LP-2A is the worked example. "Load the worked example" resets the comparison view to it |
| Approach toggle | "Minimum moves" and "Fresh layout (LPT)" in the panel workspace, and side by side in the comparison view |
| Target slider | 5–15% in the panel workspace. The search stops as soon as the target is met |
| Change list | Review dialog in the §12 format, with the transaction name, an issued-sheet warning and the ±1 VA read-back check |
| Lock a circuit | Padlock on every 1-pole breaker. An open proposal re-runs around it: locking Ckt 13 on LP-2A gives a two-circuit swap that still reaches 2.6% |
| Multi-pole rows | PP-1A and PP-R1 carry 2- and 3-pole circuits as fixed contributions |

It also covers the rest of the pipeline: a project-wide audit with a riser view, batch balance, accept and apply with undo, the §13.1 change log as CSV, the §4 pilot KPIs, a live `config.json`, the §15.1 unit tests, and an 11-scene guided dry run for presenting.

---

## 15. Validation and test plan

### 15.1 Unit tests (core)

| # | Case | Expected |
|---|---|---|
| T1 | §9 worked example, min-move, target 5% | Imbalance 2.6%, moved = {13} |
| T2 | §9 example, LPT | Imbalance 2.6%, 5 circuits moved (7, 11, 13, 15, 17) |
| T3 | Already balanced panel (≤ target) | No changes |
| T4 | All circuits locked | No changes, status "Locked-limited" |
| T5 | Only 3-pole circuits | Imbalance 0%, no changes |
| T6 | One huge 1-pole load bigger than all others combined | Target unreachable, flagged with best achievable % |
| T7 | Phase C has no free slots | No single move onto C; swaps only |
| T8 | Empty panel / zero load | Imbalance 0%, no crash |
| T9 | Mix of 2-pole and 1-pole | 2-pole load split 50/50 and never moved |

### 15.2 Integration tests (Revit)

- Sample model with 10 seeded panels (balanced, unbalanced, locked, full).
- After apply: phase totals read back from Revit match the core within ±1 VA.
- Undo (Ctrl+Z) restores the original layout fully.
- Circuit tags on plans update correctly after renumbering.

### 15.3 Pilot acceptance

- Run on one live project with an engineer of record.
- Compare against manual balancing on 20 panels: time, imbalance achieved and circuits moved.
- Go/no-go criteria: O2–O4 met on ≥ 80% of the panels.

---

## 16. Rollout plan

| Week | Milestone | Output |
|---|---|---|
| 1 | Measure the baseline (time per panel, current imbalance across one project); finalise rules with the electrical lead | Baseline sheet, signed-off `config.json` |
| 2 | Core plus unit tests; Audit button (read-only) | Project-wide audit report |
| 3 | Balance button with review dialog and transactional apply | Working pyRevit tool |
| 4 | Pilot on a live project; collect accept/reject data | Pilot report: hours saved, imbalance before/after, moves per panel |
| 5+ | v2: feeder/transformer-level balancing, grouping rule (R8), C# port, optional LLM explanations | Roadmap decision |

---

## 17. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Renumbering breaks tags on issued sheets | Min-move objective; a warning for circuits on issued sheets; `DoNotMove` flag |
| Wrong load data (missing or incorrect VA on families) | Audit flags circuits with 0 VA or missing loads before optimising |
| API behaviour differs between Revit versions | Verify every API call against the target version; read back and roll back on mismatch (§11.4) |
| Engineers distrust automated changes | Proposals only, explicit review, one-click undo, full log |
| Over-reliance on the tool | The engineer of record stays responsible; the tool is a QA aid, not a design authority |
| Data privacy with an LLM layer | The LLM is optional and runs behind a firm-approved enterprise model; only panel-level numbers are sent, never the model file |

---

## 18. Assumptions to confirm with the technical directors

1. Panels follow the standard A-B-C row sequence (§1.1). Check for any non-standard panel families.
2. The balance basis is connected VA (or demand VA if the project standard says so).
3. The firm threshold is 10% unless a project specifies otherwise.
4. pyRevit is permitted on production machines; if not, plan for the C# add-in route.
5. How Revit's built-in Rebalance Loads treats locked slots in the firm's Revit version.
6. Circuit renumbering after issue is acceptable when it goes through a revision cloud and is logged.

---

## 19. Glossary

| Term | Meaning |
|---|---|
| Panelboard / panel | Distribution board feeding branch circuits |
| Slot | Physical breaker position. Its row decides the phase |
| Pole | Number of phase conductors a breaker switches (1, 2, 3) |
| Connected load | Sum of nameplate or assigned loads, without demand factors |
| Demand load | Connected load × demand factors per load class |
| Phase imbalance | Deviation of the most-deviating phase from the average, in % |
| LPT | Longest-Processing-Time greedy heuristic |
| ILP | Integer linear programming, an exact optimisation method |
| pyRevit | Open-source framework for Python tools inside Revit |
| Transaction | Revit's atomic, undoable unit of model change |

---

## 20. Pitch summary (for the TD review)

> **Every panel audited, every imbalance fixed with the fewest possible circuit changes, and the engineer approves everything.**
> On the sample panel, imbalance falls from 23.1% to 2.6% by moving **one** circuit. A naive rebalance moves five.
> Low build effort (a pyRevit button), measurable in a 4-week pilot, and the core logic is reusable in the web demo and in a future C# add-in.

---

## 21. Revision history

| Version | Change |
|---|---|
| 1.1 | §9 circuit numbers now equal slot numbers, as §1.1 requires. The circuits sit in odd slots 1–17. Min-move moves Ckt 13 into slot 6; LPT moves Ckts 7, 11, 13, 15 and 17. Balance figures are unchanged. |
| 1.1 | §6.1, §6.2, §12, §13.1 and §15.1 examples follow the renumbering. v1.0 moved a circuit to "slot 9 (C)", but slot 9 feeds phase B. |
| 1.1 | §12 sample explanation corrected. Phase A carries two of the four largest loads, not three. |
| 1.1 | §10 notes now list every change the IronPython 2.7 engine needs. |
| 1.1 | §14 describes the built dry-run simulator instead of a list of planned features. |
| 1.0 | First issue. |
