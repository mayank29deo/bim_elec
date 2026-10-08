"""Reads panels as JSON on stdin, runs the reference Python core, prints results as JSON.
Used by tests/core.test.js to prove the JavaScript port gives identical answers."""
import json, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "reference"))
from phase_balancer import Circuit, phase_loads, imbalance_pct, lpt_balance, min_move_balance

out = []
for case in json.load(sys.stdin):
    cs = [Circuit(c["number"], c["load_va"], tuple(c["phases"]), c["locked"]) for c in case["circuits"]]
    lpt = lpt_balance(cs)
    mm, moved = min_move_balance(cs, target_pct=case["target"], slot_capacity=case.get("cap"))
    out.append({
        "before": imbalance_pct(phase_loads(cs)),
        "lpt": [list(c.phases) for c in lpt],
        "lpt_imb": imbalance_pct(phase_loads(lpt)),
        "mm": [list(c.phases) for c in mm],
        "mm_imb": imbalance_pct(phase_loads(mm)),
        "moved": sorted(moved),
    })
print(json.dumps(out))
