// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const PB = require("../src/phase_balancer.js");
const PM = require("../src/panel_model.js");

const { Circuit, PHASES, phaseLoads, imbalancePct, lptBalance, minMoveBalance } = PB;
const round1 = (x) => Math.round(x * 10) / 10;
// §9 worked example: circuits in odd slots 1–17, circuit number = slot number (§1.1).
const worked = () => [2400, 1800, 1500, 1500, 1200, 1000, 900, 800, 600].map((va, i) => Circuit(2 * i + 1, va, [PHASES[i % 3]]));

test("T1 worked example, min-move, target 5%: 2.6% with only circuit 13 moved", () => {
  const [res, moved] = minMoveBalance(worked(), { target_pct: 5 });
  assert.deepEqual(phaseLoads(res), { A: 3900, B: 3800, C: 4000 });
  assert.equal(round1(imbalancePct(phaseLoads(res))), 2.6);
  assert.deepEqual([...moved], [13]);
});

test("T2 worked example, LPT: 2.6% with circuits 7, 11, 13, 15, 17 moved", () => {
  const drawn = worked();
  const res = lptBalance(drawn);
  assert.deepEqual(phaseLoads(res), { A: 4000, B: 3900, C: 3800 });
  assert.equal(round1(imbalancePct(phaseLoads(res))), 2.6);
  const moved = res.filter((c, i) => c.phases[0] !== drawn[i].phases[0]).map((c) => c.number);
  assert.deepEqual(moved, [7, 11, 13, 15, 17]);
});

test("worked example as drawn is 23.1%", () => {
  assert.equal(round1(imbalancePct(phaseLoads(worked()))), 23.1);
});

test("T3 already balanced panel: no changes", () => {
  const cs = [Circuit(1, 1000, ["A"]), Circuit(2, 1000, ["B"]), Circuit(3, 1050, ["C"])];
  const [, moved] = minMoveBalance(cs, { target_pct: 10 });
  assert.equal(moved.size, 0);
});

test("T4 all circuits locked: no changes, panel reports Locked-limited", () => {
  const cs = [Circuit(1, 3000, ["A"], true), Circuit(2, 500, ["B"], true), Circuit(3, 500, ["C"], true)];
  const [, moved] = minMoveBalance(cs, { target_pct: 10 });
  assert.equal(moved.size, 0);
  const panel = { ways: 6, circuits: [
    { id: "x1", slot: 1, poles: 1, va: 3000, cls: "REC", doNotMove: true },
    { id: "x2", slot: 3, poles: 1, va: 500, cls: "REC", doNotMove: true },
    { id: "x3", slot: 5, poles: 1, va: 500, cls: "REC", doNotMove: true } ] };
  assert.equal(PM.audit(panel, PM.DEFAULT_CONFIG).status, "locked");
});

test("T5 only 3-pole circuits: 0% and nothing moves", () => {
  const cs = [Circuit(1, 9000, ["A", "B", "C"]), Circuit(7, 4500, ["A", "B", "C"])];
  assert.equal(imbalancePct(phaseLoads(cs)), 0);
  const [, moved] = minMoveBalance(cs, { target_pct: 5 });
  assert.equal(moved.size, 0);
});

test("T6 one huge 1-pole load: target unreachable, flagged with best achievable %", () => {
  const panel = { ways: 12, circuits: [
    { id: "h1", slot: 1, poles: 1, va: 9000, cls: "EQP" },
    { id: "h2", slot: 3, poles: 1, va: 1000, cls: "REC" },
    { id: "h3", slot: 5, poles: 1, va: 1000, cls: "REC" },
    { id: "h4", slot: 7, poles: 1, va: 1000, cls: "REC" } ] };
  const p = PM.propose(panel, PM.DEFAULT_CONFIG, "min_move");
  assert.equal(p.reached, false);
  assert.equal(p.status, "needs");
  assert.match(p.reason, /Best achievable is \d+\.\d%/);
});

test("T7 phase C has no free slots: no single move onto C, swaps only", () => {
  const cs = [Circuit(1, 3000, ["A"]), Circuit(7, 2000, ["A"]), Circuit(3, 1500, ["B"]),
    Circuit(5, 1000, ["C"]), Circuit(11, 900, ["C"]), Circuit(17, 800, ["C"])];
  const trace = [];
  const [res] = minMoveBalance(cs, { target_pct: 5, slot_capacity: { A: 6, B: 6, C: 3 }, trace });
  for (const t of trace) if (t.step && t.step.kind === "move") assert.notEqual(t.step.to[0], "C");
  assert.ok(res.filter((c) => c.phases[0] === "C").length <= 3);
});

test("T8 empty panel / zero load: 0% and no crash", () => {
  assert.equal(imbalancePct(phaseLoads([])), 0);
  const [res, moved] = minMoveBalance([Circuit(1, 0, ["A"])], { target_pct: 5 });
  assert.equal(res.length, 1);
  assert.equal(moved.size, 0);
});

test("T9 2-pole load splits 50/50 and is never moved", () => {
  const cs = [Circuit(1, 4000, ["A", "B"]), Circuit(5, 3000, ["C"]), Circuit(7, 2500, ["A"]), Circuit(9, 200, ["B"])];
  assert.deepEqual(phaseLoads([cs[0]]), { A: 2000, B: 2000, C: 0 });
  const [res] = minMoveBalance(cs, { target_pct: 5 });
  assert.deepEqual(res.find((c) => c.number === 1).phases, ["A", "B"]);
});

test("slot mapping: worked example circuit at slot 13 moves A to C into slot 6", () => {
  const vas = [2400, 1800, 1500, 1500, 1200, 1000, 900, 800, 600];
  const panel = { ways: 24, circuits: vas.map((va, i) => ({ id: "c" + i, slot: 2 * i + 1, poles: 1, va, cls: "REC" })) };
  const p = PM.propose(panel, PM.DEFAULT_CONFIG, "min_move");
  assert.equal(round1(p.beforeImb), 23.1);
  assert.equal(round1(p.afterImb), 2.6);
  assert.equal(p.changes.length, 1);
  assert.deepEqual([p.changes[0].fromSlot, p.changes[0].toSlot, p.changes[0].fromPhase, p.changes[0].toPhase], [13, 6, "A", "C"]);
  assert.ok(p.readBackOk);
  const l = PM.propose(panel, PM.DEFAULT_CONFIG, "lpt");
  assert.equal(l.changes.length, 5);
  assert.ok(l.readBackOk);
});

test("slot mapping: a swap exchanges the two slots", () => {
  const panel = { ways: 6, circuits: [
    { id: "a", slot: 1, poles: 1, va: 3000, cls: "REC" }, { id: "a2", slot: 2, poles: 1, va: 2000, cls: "REC" },
    { id: "b", slot: 3, poles: 1, va: 1000, cls: "REC" }, { id: "b2", slot: 4, poles: 1, va: 1000, cls: "REC" },
    { id: "c", slot: 5, poles: 1, va: 2000, cls: "REC" }, { id: "c2", slot: 6, poles: 1, va: 2000, cls: "REC" } ] };
  const p = PM.propose(panel, { ...PM.DEFAULT_CONFIG, target: 5 }, "min_move");
  assert.ok(p.changes.length >= 2);
  for (const ch of p.changes) if (ch.kind === "swap") assert.equal(p.changes.find((x) => x.fromSlot === ch.toSlot).toSlot, ch.fromSlot);
  assert.ok(p.readBackOk);
});

test("JavaScript port matches the Python reference on 300 random panels", () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const cases = [];
  for (let k = 0; k < 300; k++) {
    const n = 2 + Math.floor(rnd() * 16);
    const circuits = [];
    for (let i = 0; i < n; i++) {
      const r = rnd();
      const poles = r < 0.75 ? 1 : r < 0.88 ? 2 : 3;
      const start = Math.floor(rnd() * 3);
      const phases = PHASES.slice(start).concat(PHASES.slice(0, start)).slice(0, poles);
      circuits.push({ number: i + 1, load_va: Math.round(100 + rnd() * 4000), phases, locked: rnd() < 0.1 });
    }
    const target = [5, 10, 15][k % 3];
    const cap = k % 2 ? { A: 4 + Math.floor(rnd() * 4), B: 4 + Math.floor(rnd() * 4), C: 4 + Math.floor(rnd() * 4) } : null;
    cases.push({ circuits, target, cap });
  }
  let py;
  try {
    py = JSON.parse(execFileSync("python3", ["-I", path.join(__dirname, "parity_runner.py")], { input: JSON.stringify(cases), timeout: 30000 }).toString());
  } catch (e) {
    return test.skip("python3 not available");
  }
  cases.forEach((cs, k) => {
    const circuits = cs.circuits.map((c) => Circuit(c.number, c.load_va, c.phases, c.locked));
    const lpt = lptBalance(circuits);
    const [mm, moved] = minMoveBalance(circuits, { target_pct: cs.target, slot_capacity: cs.cap });
    assert.deepEqual(lpt.map((c) => c.phases), py[k].lpt, `case ${k} LPT`);
    assert.deepEqual(mm.map((c) => c.phases), py[k].mm, `case ${k} min-move`);
    assert.deepEqual([...moved].sort((a, b) => a - b), py[k].moved, `case ${k} moved set`);
    assert.ok(Math.abs(imbalancePct(phaseLoads(mm)) - py[k].mm_imb) < 1e-9, `case ${k} imbalance`);
  });
});
