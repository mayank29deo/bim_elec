/*
 * Phase balancer core.
 * Line-for-line JavaScript port of reference/phase_balancer.py (concept document §10).
 * No DOM, no dependencies: runs in the browser (window.PhaseBalancer) and in Node (require).
 *
 * The only addition to the Python is an optional `trace` array on minMoveBalance, which
 * records each search iteration so the UI can explain what the optimiser did.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PhaseBalancer = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PHASES = ["A", "B", "C"];

  // Circuit: { number, load_va, phases: ["A"] | ["A","B"] | ["A","B","C"], locked }
  function Circuit(number, load_va, phases, locked = false) {
    return { number, load_va, phases: phases.slice(), locked: !!locked };
  }

  function isMovable(c) {
    return c.phases.length === 1 && !c.locked;
  }

  function replacePhases(c, phases) {
    return Object.assign({}, c, { phases: phases.slice() });
  }

  function samePhases(a, b) {
    return a.length === b.length && a.every((p, i) => p === b[i]);
  }

  function phaseLoads(circuits) {
    const loads = { A: 0.0, B: 0.0, C: 0.0 };
    for (const c of circuits) {
      const share = c.load_va / c.phases.length; // multi-pole load splits equally
      for (const p of c.phases) loads[p] += share;
    }
    return loads;
  }

  function imbalancePct(loads) {
    const avg = (0 + loads.A + loads.B + loads.C) / 3;
    if (avg === 0) return 0.0;
    return Math.max(Math.abs(loads.A - avg), Math.abs(loads.B - avg), Math.abs(loads.C - avg)) / avg * 100;
  }

  /* Greedy Longest-Processing-Time: biggest movable load to lightest phase.
     Ignores current positions, so it usually moves many circuits. */
  function lptBalance(circuits) {
    const fixed = circuits.filter((c) => !isMovable(c));
    const movable = circuits.filter(isMovable).sort((a, b) => b.load_va - a.load_va); // stable, like sorted()
    const loads = phaseLoads(fixed);
    const result = fixed.slice();
    for (const c of movable) {
      let p = PHASES[0];
      for (const q of PHASES) if (loads[q] < loads[p]) p = q; // min() keeps the first minimum
      loads[p] += c.load_va;
      result.push(replacePhases(c, [p]));
    }
    return result.sort((a, b) => a.number - b.number);
  }

  /* Local search starting from the drawn layout. Each step applies the single
     move or pairwise swap that cuts imbalance the most per circuit renumbered,
     and stops once the target is met or nothing improves.
     Returns [circuits, movedSet] like the Python tuple. */
  function minMoveBalance(circuits, opts) {
    const o = opts || {};
    const target_pct = o.target_pct == null ? 5.0 : o.target_pct;
    const slot_capacity = o.slot_capacity || null;
    const max_iter = o.max_iter == null ? 50 : o.max_iter;
    const trace = o.trace || null;

    let cur = new Map(circuits.map((c) => [c.number, c])); // Map keeps insertion order, like dict
    const moved = new Set();

    const countOn = (phase, state) => {
      let n = 0;
      for (const c of state.values()) if (isMovable(c) && c.phases[0] === phase) n++;
      return n;
    };

    let stopReason = "iteration limit";
    for (let iter = 1; iter <= max_iter; iter++) {
      const loads = phaseLoads(cur.values());
      const base = imbalancePct(loads);
      if (base <= target_pct) { stopReason = "target met"; break; }
      let best = null; // { gain, state, touched, step }
      const movables = [...cur.values()].filter(isMovable);
      let evaluatedMoves = 0, evaluatedSwaps = 0, blockedByCapacity = 0;
      // single moves
      for (const c of movables) {
        for (const p of PHASES) {
          if (p === c.phases[0]) continue;
          if (slot_capacity && countOn(p, cur) >= slot_capacity[p]) { blockedByCapacity++; continue; }
          const trial = new Map(cur);
          trial.set(c.number, replacePhases(c, [p]));
          evaluatedMoves++;
          const after = imbalancePct(phaseLoads(trial.values()));
          const gain = base - after;
          if (gain > 1e-9 && (best === null || gain > best.gain)) {
            best = { gain, state: trial, touched: [c.number],
              step: { kind: "move", numbers: [c.number], from: [c.phases[0]], to: [p], after } };
          }
        }
      }
      // swaps (keep slot counts unchanged)
      for (let i = 0; i < movables.length; i++) {
        for (let j = i + 1; j < movables.length; j++) {
          const a = movables[i], b = movables[j];
          if (samePhases(a.phases, b.phases)) continue;
          const trial = new Map(cur);
          trial.set(a.number, replacePhases(a, b.phases));
          trial.set(b.number, replacePhases(b, a.phases));
          evaluatedSwaps++;
          const after = imbalancePct(phaseLoads(trial.values()));
          const gain = (base - after) / 2;
          if (gain > 1e-9 && (best === null || gain > best.gain)) {
            best = { gain, state: trial, touched: [a.number, b.number],
              step: { kind: "swap", numbers: [a.number, b.number], from: [a.phases[0], b.phases[0]], to: [b.phases[0], a.phases[0]], after } };
          }
        }
      }
      if (best === null) {
        stopReason = "no improving move";
        if (trace) trace.push({ iter, before: base, evaluatedMoves, evaluatedSwaps, blockedByCapacity, step: null });
        break;
      }
      if (trace) trace.push({ iter, before: base, evaluatedMoves, evaluatedSwaps, blockedByCapacity, gainPerCircuit: best.gain, step: best.step });
      cur = best.state;
      for (const n of best.touched) moved.add(n);
    }
    if (stopReason === "iteration limit" && imbalancePct(phaseLoads(cur.values())) <= target_pct) stopReason = "target met";
    if (trace) trace.stopReason = stopReason;

    const original = new Map(circuits.map((c) => [c.number, c.phases]));
    const finalMoved = new Set([...moved].filter((n) => !samePhases(cur.get(n).phases, original.get(n))));
    return [[...cur.values()].sort((a, b) => a.number - b.number), finalMoved];
  }

  return { PHASES, Circuit, isMovable, phaseLoads, imbalancePct, lptBalance, minMoveBalance };
});
