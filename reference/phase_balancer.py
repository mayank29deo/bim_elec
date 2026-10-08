# phase_balancer.py
# Reference implementation from §10 of the concept document (v1.1).
# The JavaScript core in src/phase_balancer.js is a line-for-line port of this file.
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
