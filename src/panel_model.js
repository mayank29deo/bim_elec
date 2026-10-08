/*
 * Panel model: the "Revit layer" of the concept (§11), simulated.
 * Translates a panelboard (slots, poles, locks, spares) into core circuits, runs the core,
 * and maps the core's phase decisions back onto concrete slots (§11.4).
 */
(function (root, factory) {
  const PB = typeof module === "object" && module.exports ? require("./phase_balancer.js") : root.PhaseBalancer;
  const api = factory(PB);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PanelModel = api;
})(typeof self !== "undefined" ? self : this, function (PB) {
  "use strict";
  const PHASES = PB.PHASES;

  const DEFAULT_CONFIG = {
    target: 10,                 // imbalance_target_pct
    basis: "connected",         // balance_basis: connected | demand
    approach: "min_move",       // default_approach: min_move | lpt
    maxMoves: 6,                // max_moves_per_panel
    respectLocks: true,         // respect_locked_slots
    doNotMoveParam: "DoNotMove",
    voltage: "400/230",
    engineer: "Pilot engineer",
    demandFactors: { LTG: 1.0, REC: 0.8, EQP: 0.75, MECH: 1.0 },
  };

  const VOLTAGES = {
    "400/230": { ll: 400, ln: 230, label: "400/230 V 3Φ 4W" },
    "415/240": { ll: 415, ln: 240, label: "415/240 V 3Φ 4W" },
    "208/120": { ll: 208, ln: 120, label: "208Y/120 V 3Φ 4W" },
    "480/277": { ll: 480, ln: 277, label: "480Y/277 V 3Φ 4W" },
  };

  // §1.1: rows feed A, B, C in sequence; odd slots left, even slots right.
  function phaseOfSlot(slot) {
    return PHASES[(Math.ceil(slot / 2) - 1) % 3];
  }
  function rowOfSlot(slot) {
    return Math.ceil(slot / 2);
  }
  // A multi-pole breaker occupies consecutive rows in the same column: s, s+2, s+4.
  function slotsOf(c) {
    const s = [];
    for (let k = 0; k < c.poles; k++) s.push(c.slot + 2 * k);
    return s;
  }
  function phasesOf(c) {
    return slotsOf(c).map(phaseOfSlot);
  }

  function isLocked(c, cfg) {
    return !!c.doNotMove || (!!c.lockedSlot && cfg.respectLocks !== false);
  }
  function basisVA(c, cfg) {
    if (c.spare) return 0;
    if (cfg.basis === "demand") {
      const f = cfg.demandFactors && cfg.demandFactors[c.cls];
      return c.va * (f == null ? 1 : f);
    }
    return c.va;
  }
  function loadCircuits(panel) {
    return panel.circuits.filter((c) => !c.spare);
  }

  function toCore(panel, cfg, opts) {
    const ignoreLocks = opts && opts.ignoreLocks;
    return loadCircuits(panel)
      .slice()
      .sort((a, b) => a.slot - b.slot)
      .map((c) => PB.Circuit(c.slot, basisVA(c, cfg), phasesOf(c), ignoreLocks ? false : isLocked(c, cfg)));
  }

  // slot -> circuit, for every slot a circuit (or spare) occupies
  function occupancy(panel) {
    const occ = new Map();
    for (const c of panel.circuits) for (const s of slotsOf(c)) occ.set(s, c);
    return occ;
  }

  // R7: spaces (empty) and spares are valid move targets.
  function freeSlotsByPhase(panel) {
    const occ = occupancy(panel);
    const free = { A: [], B: [], C: [] };
    for (let s = 1; s <= panel.ways; s++) {
      const c = occ.get(s);
      if (!c || c.spare) free[phaseOfSlot(s)].push(s);
    }
    return free;
  }

  // R4: 1-pole circuits on a phase cannot exceed the slots that phase can offer them.
  function slotCapacity(panel, cfg, opts) {
    const free = freeSlotsByPhase(panel);
    const cap = { A: free.A.length, B: free.B.length, C: free.C.length };
    for (const c of toCore(panel, cfg, opts)) if (PB.isMovable(c)) cap[c.phases[0]]++;
    return cap;
  }

  function onePoleLoads(panel, cfg) {
    const L = { A: 0, B: 0, C: 0 };
    for (const c of loadCircuits(panel)) if (c.poles === 1) L[phaseOfSlot(c.slot)] += basisVA(c, cfg);
    return L;
  }

  // Neutral current from 1-pole (L-N) loads at unity power factor. 2- and 3-pole loads add no neutral current.
  function neutralCurrent(L1p, vln) {
    const a = L1p.A / vln, b = L1p.B / vln, c = L1p.C / vln;
    return Math.sqrt(Math.max(0, a * a + b * b + c * c - a * b - b * c - c * a));
  }

  function audit(panel, cfg) {
    const core = toCore(panel, cfg);
    const loads = PB.phaseLoads(core);
    const imb = PB.imbalancePct(loads);
    const movable = core.filter(PB.isMovable).length;
    const lockedCount = loadCircuits(panel).filter((c) => isLocked(c, cfg)).length;
    const zeroLoad = loadCircuits(panel).filter((c) => !(c.va > 0));
    let status = imb <= cfg.target ? "ok" : movable === 0 ? "locked" : "over";
    return { loads, imb, status, movable, lockedCount, zeroLoad, total: loads.A + loads.B + loads.C };
  }

  /* Map the core's phase decisions onto concrete slots (§11.4).
     1. A circuit going p→q and another going q→p exchange slots directly (a swap).
     2. Every other moved circuit takes the lowest-numbered free slot on its new phase.
     3. A spare displaced from its slot takes over a slot vacated by a moved circuit. */
  function mapToSlots(panel, newPhase /* Map oldSlot -> phase, for moved circuits only */) {
    const bySlot = new Map(panel.circuits.map((c) => [c.slot, c]));
    const moved = [...newPhase.keys()].sort((a, b) => a - b).map((s) => bySlot.get(s));
    const target = new Map(); // oldSlot -> newSlot
    const partner = new Map();
    const unpaired = [];
    // 1. pair direct swaps
    for (const x of moved) {
      if (target.has(x.slot)) continue;
      const from = phaseOfSlot(x.slot), to = newPhase.get(x.slot);
      const y = moved.find((m) => m !== x && !target.has(m.slot) && phaseOfSlot(m.slot) === to && newPhase.get(m.slot) === from);
      if (y) {
        target.set(x.slot, y.slot); target.set(y.slot, x.slot);
        partner.set(x.slot, y.slot); partner.set(y.slot, x.slot);
      }
    }
    for (const x of moved) if (!target.has(x.slot)) unpaired.push(x);
    // 2. pool = free slots (spaces + spares) + slots vacated by unpaired movers
    const free = freeSlotsByPhase(panel);
    const pool = { A: free.A.slice(), B: free.B.slice(), C: free.C.slice() };
    for (const x of unpaired) pool[phaseOfSlot(x.slot)].push(x.slot);
    for (const p of PHASES) pool[p].sort((a, b) => a - b);
    const used = new Set();
    const errors = [];
    for (const x of unpaired) {
      const to = newPhase.get(x.slot);
      const s = pool[to].find((k) => !used.has(k) && k !== x.slot);
      if (s == null) { errors.push(`No free slot on phase ${to} for circuit ${x.slot}`); continue; }
      used.add(s);
      target.set(x.slot, s);
    }
    // 3. displaced spares move into vacated slots that nobody reused
    const occ = occupancy(panel);
    const vacated = unpaired.map((x) => x.slot).filter((s) => !used.has(s)).sort((a, b) => a - b);
    const spareMoves = [];
    for (const s of [...used].sort((a, b) => a - b)) {
      const o = occ.get(s);
      if (o && o.spare) {
        const dest = vacated.shift();
        if (dest == null) { errors.push(`No slot left for displaced spare ${s}`); continue; }
        spareMoves.push({ fromSlot: s, toSlot: dest });
        target.set(s, dest);
      }
    }
    const changes = moved.filter((x) => target.has(x.slot)).map((x) => ({
      id: x.id, name: x.name, va: x.va, cls: x.cls, sheets: x.sheets || [],
      fromSlot: x.slot, toSlot: target.get(x.slot),
      fromPhase: phaseOfSlot(x.slot), toPhase: phaseOfSlot(target.get(x.slot)),
      kind: partner.has(x.slot) ? "swap" : "move",
      partnerSlot: partner.get(x.slot) || null,
    }));
    const circuits = panel.circuits.map((c) => (target.has(c.slot) ? Object.assign({}, c, { slot: target.get(c.slot) }) : Object.assign({}, c)));
    return { changes, spareMoves, circuits, errors };
  }

  function bestEffortReason(panel, cfg, afterImb) {
    // Would the target be reachable if locks were ignored? Then locks are the limiting factor.
    const unlocked = toCore(panel, cfg, { ignoreLocks: true });
    const [res] = PB.minMoveBalance(unlocked, { target_pct: cfg.target, slot_capacity: slotCapacity(panel, cfg, { ignoreLocks: true }) });
    const unlockedImb = PB.imbalancePct(PB.phaseLoads(res));
    const hasLocks = loadCircuits(panel).some((c) => isLocked(c, cfg));
    if (hasLocks && unlockedImb <= cfg.target) {
      return { status: "locked", reason: `Locked circuits block the fix. Without locks the panel could reach ${unlockedImb.toFixed(1)}%.` };
    }
    const biggest = loadCircuits(panel).filter((c) => c.poles === 1).sort((a, b) => b.va - a.va)[0];
    if (biggest) {
      const others = loadCircuits(panel).reduce((s, c) => s + basisVA(c, cfg), 0) - basisVA(biggest, cfg);
      if (basisVA(biggest, cfg) > others / 2) {
        return { status: "needs", reason: `Circuit ${biggest.slot} (${Math.round(biggest.va).toLocaleString("en-GB")} VA) outweighs what the other two phases can offset. Best achievable is ${afterImb.toFixed(1)}%.` };
      }
    }
    return { status: "needs", reason: `No further move or swap improves balance. Best achievable is ${afterImb.toFixed(1)}%.` };
  }

  function propose(panel, cfg, approach) {
    const appr = approach || cfg.approach;
    const core = toCore(panel, cfg);
    const before = PB.phaseLoads(core);
    const beforeImb = PB.imbalancePct(before);
    const cap = slotCapacity(panel, cfg);
    const trace = [];
    let result, movedSet;
    if (appr === "lpt") {
      result = PB.lptBalance(core);
      const orig = new Map(core.map((c) => [c.number, c.phases.join("")]));
      movedSet = new Set(result.filter((c) => c.phases.join("") !== orig.get(c.number)).map((c) => c.number));
      trace.stopReason = "LPT assigns every movable circuit from scratch";
    } else {
      [result, movedSet] = PB.minMoveBalance(core, { target_pct: cfg.target, slot_capacity: cap, trace });
    }
    const after = PB.phaseLoads(result);
    const afterImb = PB.imbalancePct(after);
    const newPhase = new Map();
    for (const c of result) if (movedSet.has(c.number)) newPhase.set(c.number, c.phases[0]);
    const mapped = mapToSlots(panel, newPhase);

    // §11.4 read-back: recompute loads from the mapped slot layout and compare with the core's prediction.
    const readBack = PB.phaseLoads(toCore({ ways: panel.ways, circuits: mapped.circuits }, cfg));
    const readBackOk = PHASES.every((p) => Math.abs(readBack[p] - after[p]) <= 1) && mapped.errors.length === 0;

    const reached = afterImb <= cfg.target;
    let status, reason = "";
    if (beforeImb <= cfg.target && appr !== "lpt") { status = "ok"; reason = "Already within target. No changes proposed."; }
    else if (!readBackOk) { status = "needs"; reason = mapped.errors[0] || "Slot read-back did not match the prediction, so the proposal was rolled back."; }
    else if (reached) { status = "proposed"; }
    else ({ status, reason } = bestEffortReason(panel, cfg, afterImb));

    const warnings = [];
    if (mapped.changes.length > cfg.maxMoves) warnings.push(`This proposal renumbers ${mapped.changes.length} circuits, above the firm limit of ${cfg.maxMoves} per panel.`);
    const issued = new Set();
    for (const ch of mapped.changes) for (const sh of ch.sheets) if (sh.issued) issued.add(sh.id);
    if (issued.size) warnings.push(`Moved circuits are tagged on issued sheet${issued.size > 1 ? "s" : ""} ${[...issued].join(", ")}. Cloud the revision before re-issue.`);

    return {
      approach: appr, target: cfg.target, basis: cfg.basis,
      before, beforeImb, after, afterImb, reached, status, reason, warnings,
      changes: mapped.changes, spareMoves: mapped.spareMoves, newCircuits: mapped.circuits,
      trace, readBack, readBackOk, slotCapacity: cap,
    };
  }

  return {
    DEFAULT_CONFIG, VOLTAGES, phaseOfSlot, rowOfSlot, slotsOf, phasesOf, isLocked, basisVA,
    toCore, occupancy, freeSlotsByPhase, slotCapacity, onePoleLoads, neutralCurrent, audit, mapToSlots, propose,
  };
});
