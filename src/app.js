/*
 * Phase-Balancing Copilot · dry-run simulator UI.
 * Vanilla JavaScript, no build step. All numbers come from src/phase_balancer.js (the core)
 * and src/panel_model.js (the simulated Revit layer); this file only orchestrates and draws.
 */
(function () {
  "use strict";
  const PB = window.PhaseBalancer, PM = window.PanelModel, SP = window.SampleProject;
  const PHASES = PB.PHASES;

  // ---------------------------------------------------------------- helpers
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Math.round(n).toLocaleString("en-GB");
  const pct = (x) => `${(Math.round(x * 10) / 10).toFixed(1)}%`;
  const amp = (va) => (va / PM.VOLTAGES[S.cfg.voltage].ln).toFixed(1);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const icon = (id, cls = "") => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
  const pad = (n) => String(n).padStart(2, "0");
  const isoMin = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const hms = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const reduced = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const phtag = (ph) => `<span class="phtag ph-${ph}">${ph}</span>`;
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };
  const CLS = { LTG: "Lighting", REC: "Receptacles", EQP: "Equipment", MECH: "Mechanical" };
  const STATUS = {
    unknown: { label: () => "Not checked", icon: "dot" },
    ok: { label: () => `Within ${S.cfg.target}%`, icon: "check" },
    over: { label: () => `Over ${S.cfg.target}%`, icon: "alert" },
    proposed: { label: () => "Fix ready", icon: "bolt" },
    accepted: { label: () => "Accepted", icon: "check" },
    applied: { label: () => "Fixed", icon: "check" },
    rejected: { label: () => "Rejected", icon: "x" },
    needs: { label: () => "Needs engineer", icon: "alert" },
    locked: { label: () => "Blocked by locks", icon: "lock" },
  };
  const chip = (st) => `<span class="chip chip-${st}">${icon(STATUS[st].icon)}${STATUS[st].label()}</span>`;
  const FFL = { "Roof": "+17.60", "Level 04": "+13.20", "Level 03": "+8.80", "Level 02": "+4.40", "Level 01": "±0.00" };
  const STEPS = ["Audit", "Optimise", "Propose", "Review", "Apply & report"];
  const TABS = [["audit", "Audit", "scan"], ["workspace", "Panel", "board"], ["compare", "Compare", "compare"], ["report", "Report", "report"], ["rules", "Settings", "gear"]];

  // ---------------------------------------------------------------- state
  const S = {
    cfg: clone(PM.DEFAULT_CONFIG),
    panels: [], view: "audit", sel: "LP-2A", selCircuit: null,
    boardMode: "drawn", boardStyle: "board", opts: false,
    log: [], activity: [], tx: [],
    compare: "LP-2A", sort: { key: "imb", dir: -1 },
    tour: { on: false, i: 0, auto: false, timer: null },
    anim: {}, designSeq: 0, viz: {}, tests: null, open: {},
    intro: !store.get("pbc-intro-hidden"),
    // CSV saving: "local" = plain browser download; inside the claude.ai viewer the downloads capability is used.
    dl: window.claude && typeof window.claude.use === "function" ? "pending" : "local", dlNs: null,
  };

  function resetProject() {
    S.panels = SP.build().map((p) => Object.assign(p, { audit: null, proposal: null, review: null }));
    S.log = []; S.activity = []; S.tx = []; S.selCircuit = null; S.boardMode = "drawn"; S.designSeq = 0; S.viz = {};
  }
  const panel = (id) => S.panels.find((p) => p.id === id);
  // Loads and layout only: flagging a lock is not a model change the audit needs to re-read.
  const modelSig = (p) => p.circuits.map((c) => `${c.slot}:${c.va}:${c.poles}`).join("|");
  const live = (p) => PM.audit(p, S.cfg);
  const isStale = (p) => !!p.audit && p.audit.sig !== modelSig(p);

  function activity(text, kind) { S.activity.unshift({ t: new Date(), text, kind: kind || "info" }); S.activity.length = Math.min(S.activity.length, 80); }

  // keepBaseline: re-read after an apply keeps the imbalance found by the last audit run.
  function snapshot(p, keepBaseline) {
    const a = live(p);
    const baseline = keepBaseline && p.audit ? p.audit.baseline : a.imb;
    p.audit = { imb: a.imb, baseline, loads: a.loads, movable: a.movable, zero: a.zeroLoad.length, sig: modelSig(p), at: new Date() };
  }
  function auditStatus(p) {
    if (!p.audit) return "unknown";
    if (p.audit.imb <= S.cfg.target) return "ok";
    return p.audit.movable === 0 ? "locked" : "over";
  }
  function panelStatus(p) {
    if (p.review === "applied") return "applied";
    const pr = p.proposal;
    if (pr) {
      if (p.review === "rejected") return "rejected";
      if (pr.status === "proposed") return p.review === "accepted" ? "accepted" : "proposed";
      if (pr.status === "ok") return auditStatus(p) === "unknown" ? "ok" : auditStatus(p);
      return pr.status;
    }
    return auditStatus(p);
  }
  function auditSummary() {
    const audited = S.panels.filter((p) => p.audit);
    if (!audited.length) return null;
    const over = audited.filter((p) => p.audit.imb > S.cfg.target);
    const worst = audited.slice().sort((a, b) => b.audit.imb - a.audit.imb)[0];
    return { n: audited.length, over: over.length, worst };
  }
  function heaviest(loads) {
    const avg = (loads.A + loads.B + loads.C) / 3;
    const [ph, dev] = PHASES.map((q) => [q, loads[q] - avg]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
    return { ph, dev, avg, L: loads[ph] };
  }

  // ---------------------------------------------------------------- actions
  function runAudit(animate) {
    S.panels.forEach((p) => snapshot(p));
    activity(`Audit started · ${S.panels.length} panels · target ${S.cfg.target}% · ${S.cfg.basis} VA`);
    for (const p of S.panels) {
      const st = auditStatus(p);
      if (st !== "ok") activity(`${p.name} at ${pct(p.audit.imb)} · ${STATUS[st].label()}`, "alarm");
      if (p.audit.zero) activity(`${p.name}: ${plural(p.audit.zero, "circuit")} with no load set. Check the family data.`, "warn");
    }
    const s = auditSummary();
    activity(`${s.n} panels checked · ${s.over} above ${S.cfg.target}% · worst: ${s.worst.name} at ${pct(s.worst.audit.imb)}`, "ok");
    if (animate) S.anim.audit = true;
  }

  function propose(p, approach, opts) {
    const o = opts || {};
    const pr = PM.propose(p, S.cfg, approach || S.cfg.approach);
    pr.sig = modelSig(p);
    p.proposal = pr; p.review = null;
    if (!o.quiet) {
      if (pr.status === "proposed") activity(`${p.name}: fix found · ${plural(pr.changes.length, "circuit")} renumbered · ${pct(pr.beforeImb)} → ${pct(pr.afterImb)}`, "ok");
      else if (pr.status === "ok") activity(`${p.name}: within target at ${pct(pr.beforeImb)}. No changes needed.`);
      else activity(`${p.name}: ${STATUS[pr.status].label()}. ${pr.reason}`, "warn");
    }
    if (o.log && (pr.status === "needs" || pr.status === "locked")) logEntry(p, pr, pr.status === "locked" ? "Locked-limited" : "Needs engineer");
    return pr;
  }

  function flaggedPanels() { return S.panels.filter((p) => p.review !== "applied" && ["over", "locked"].includes(auditStatus(p))); }
  function balanceAllFlagged() {
    const flagged = flaggedPanels();
    activity(`Batch run on ${plural(flagged.length, "flagged panel")} · ${S.cfg.approach === "lpt" ? "fresh layout" : "minimum moves"}`);
    flagged.forEach((p) => propose(p, S.cfg.approach, { log: true }));
    return flagged;
  }

  function logEntry(p, pr, status) {
    S.log.push({
      timestamp: isoMin(new Date()), project: SP.project.number, panel: p.name, basis: pr.basis,
      LA_before: Math.round(pr.before.A), LB_before: Math.round(pr.before.B), LC_before: Math.round(pr.before.C),
      imbalance_before_pct: pr.beforeImb.toFixed(1),
      LA_after: Math.round(pr.after.A), LB_after: Math.round(pr.after.B), LC_after: Math.round(pr.after.C),
      imbalance_after_pct: pr.afterImb.toFixed(1),
      circuits_moved: pr.changes.length,
      changes: pr.changes.map((c) => `${c.fromSlot}:${c.fromPhase}→${c.toPhase}(slot ${c.fromSlot}→${c.toSlot})`).join("; "),
      status, engineer: S.cfg.engineer, approach: pr.approach,
    });
  }

  function review(p, decision) {
    if (!p.proposal) return;
    p.review = decision;
    if (decision === "rejected") { logEntry(p, p.proposal, "Rejected"); activity(`${p.name}: fix rejected by ${S.cfg.engineer}`, "warn"); }
    else activity(`${p.name}: fix accepted, waiting to apply`, "ok");
  }
  const pendingPanels = () => S.panels.filter((p) => p.proposal && p.proposal.status === "proposed" && !p.review);
  const acceptedPanels = () => S.panels.filter((p) => p.review === "accepted" && p.proposal);

  function apply(p, group) {
    const pr = p.proposal;
    if (!pr || !pr.changes.length) return false;
    const prev = clone(p.circuits);
    p.circuits = clone(pr.newCircuits);
    const back = live(p).loads;
    if (!PHASES.every((ph) => Math.abs(back[ph] - pr.after[ph]) <= 1)) {
      p.circuits = prev;
      activity(`${p.name}: read-back did not match the prediction. Change rolled back.`, "alarm");
      return false;
    }
    const name = `Phase Balancer – ${p.name}`;
    S.tx.unshift({ id: `tx${Date.now()}${Math.random().toString(16).slice(2, 6)}`, name, group: group || null, panelId: p.id, prev, changes: pr.changes.length, at: new Date(), undone: false });
    p.review = "applied";
    snapshot(p, true);
    logEntry(p, pr, "Applied");
    activity(`Transaction "${name}" committed · ${plural(pr.changes.length, "circuit")} renumbered · read-back within ±1 VA`, "ok");
    return true;
  }
  function applyAccepted() {
    const acc = acceptedPanels();
    if (!acc.length) return 0;
    const group = `Phase Balancer – batch of ${plural(acc.length, "panel")}`;
    activity(`Transaction group "${group}" started`);
    let n = 0;
    for (const p of acc) if (apply(p, group)) n++;
    return n;
  }
  function undo(txId) {
    const t = S.tx.find((x) => x.id === txId);
    if (!t || t.undone) return;
    const p = panel(t.panelId);
    p.circuits = clone(t.prev); t.undone = true;
    const lastApplied = [...S.log].reverse().find((r) => r.panel === p.name && r.status === "Applied");
    if (lastApplied) S.log.push(Object.assign({}, lastApplied, { timestamp: isoMin(new Date()), status: "Undone" }));
    p.review = null; p.proposal = null; snapshot(p, true);
    activity(`Undo "${t.name}" · original layout restored`, "warn");
  }

  function modelChanged(p) {
    p.proposal = null; p.review = null;
    if (S.sel === p.id) S.boardMode = "drawn";
  }

  const DESIGN_CHANGES = [
    { kind: "Equipment swap", delta: 1400 },
    { kind: "Receptacles added", delta: 700 },
    { kind: "Fixture wattage revised", delta: -300 },
  ];
  function simulateDesignChange(p) {
    const cands = p.circuits.filter((c) => !c.spare && c.poles === 1);
    if (!cands.length) return null;
    const c = cands[(S.designSeq * 5 + 2) % cands.length];
    const ch = DESIGN_CHANGES[S.designSeq % DESIGN_CHANGES.length];
    S.designSeq++;
    const old = c.va;
    c.va = Math.max(100, c.va + ch.delta);
    modelChanged(p);
    activity(`${p.name}: ${ch.kind.toLowerCase()} on circuit ${c.slot} "${c.name}" ${fmt(old)} → ${fmt(c.va)} VA`, "warn");
    return { c, old, ch };
  }

  function toggleLock(p, cid) {
    const c = p.circuits.find((x) => x.id === cid);
    if (!c || c.spare || c.poles > 1) return false;
    const had = p.proposal && p.review !== "applied" ? p.proposal.approach : null;
    if (c.lockedSlot && S.cfg.respectLocks) { c.lockedSlot = false; c.doNotMove = false; }
    else c.doNotMove = !c.doNotMove;
    activity(`${p.name}: circuit ${c.slot} "${c.name}" ${PM.isLocked(c, S.cfg) ? "locked (DoNotMove)" : "unlocked"}`);
    modelChanged(p);
    if (had) { propose(p, had); return true; }
    return false;
  }

  function configChanged() {
    for (const p of S.panels) {
      if (p.audit && !isStale(p)) snapshot(p);
      if (p.proposal && p.review !== "applied") propose(p, p.proposal.approach, { quiet: true });
    }
  }

  // ---------------------------------------------------------------- rendering
  function render() {
    const focusId = document.activeElement && document.activeElement.id;
    const bScroll = $("#browser").scrollTop;
    $("#top").innerHTML = viewTop();
    $("#tabs").innerHTML = viewTabs();
    $("#bnav").innerHTML = viewBnav();
    $("#browser").innerHTML = viewBrowser();
    $("#browser").scrollTop = bScroll;
    const main = $("#main");
    main.innerHTML = (VIEWS[S.view] || VIEWS.audit)();
    main.dataset.view = S.view;
    const pz = $("#presenter");
    pz.hidden = !S.tour.on;
    pz.innerHTML = S.tour.on ? viewPresenter() : "";
    document.body.classList.toggle("touring", S.tour.on);
    if (focusId) { const el = document.getElementById(focusId); if (el) el.focus({ preventScroll: true }); }
    afterRender();
    S.anim = {};
  }
  const openAttr = (id, dflt) => ((S.open[id] == null ? dflt : S.open[id]) ? "open" : "");

  function pipelineState() {
    if (S.tour.on) return { now: SCENES[S.tour.i].step, done: SCENES[S.tour.i].step - 1 };
    let done = 0;
    if (S.panels.some((p) => p.audit)) done = 1;
    if (S.panels.some((p) => p.proposal)) done = 3;
    if (done === 3 && !pendingPanels().length) done = 4;
    if (S.tx.some((t) => !t.undone)) done = 5;
    return { now: Math.min(done + 1, 5), done };
  }

  function viewTop() {
    const ps = pipelineState();
    const steps = STEPS.map((s, i) => {
      const n = i + 1;
      const cls = n <= ps.done ? "done" : n === ps.now ? "now" : "";
      return `<li class="${cls}">${i ? `<span class="wire ${n <= ps.done ? "done" : ""}"></span>` : ""}${s}</li>`;
    }).join("");
    return `
      <div class="brand">
        <span class="plate plate-lg">Phase-Balancing Copilot</span>
        <div class="brand-meta"><span>${SP.project.number} · ${esc(SP.project.name)}</span><span class="dry">Dry run · sample data · no Revit connection</span></div>
      </div>
      <ol class="pipeline" aria-label="Copilot steps">${steps}</ol>
      <div class="top-actions">
        ${S.tour.on ? "" : `<button class="btn btn-ink" data-act="tour-start" aria-label="Guided dry run">${icon("play")}<span>Guided dry run</span></button>`}
        <button class="icon-btn" data-act="help" title="How phase balancing works" aria-label="How phase balancing works">${icon("help")}</button>
        <button class="icon-btn hide-m" data-act="reset" title="Reset the sample model" aria-label="Reset the sample model">${icon("reset")}</button>
        <button class="icon-btn" data-act="theme" title="Switch light or dark" aria-label="Switch light or dark">${icon("theme")}</button>
      </div>`;
  }

  function badgeFor(id) {
    if (id === "audit") { const n = pendingPanels().length + acceptedPanels().length; return n ? String(n) : ""; }
    if (id === "report") return S.log.length ? String(S.log.length) : "";
    return "";
  }
  function viewTabs() {
    return TABS.map(([id, label]) => {
      const extra = id === "workspace" ? ` · ${S.sel}` : "";
      const b = badgeFor(id);
      return `<button role="tab" id="tab-${id}" aria-selected="${S.view === id}" data-act="view" data-id="${id}">${label}${extra}${b ? `<span class="count">${b}</span>` : ""}</button>`;
    }).join("");
  }
  function viewBnav() {
    return TABS.map(([id, label, ic]) => {
      const b = badgeFor(id);
      return `<button data-act="view" data-id="${id}" aria-current="${S.view === id ? "page" : "false"}">${icon(ic)}${label}${b ? `<span class="badge">${b}</span>` : ""}</button>`;
    }).join("");
  }

  function viewBrowser() {
    const lv = SP.levels.map((level) => {
      const items = S.panels.filter((p) => p.level === level).map((p) => {
        const st = panelStatus(p);
        return `<button class="pb-item" data-act="open-panel" data-id="${p.id}" aria-current="${S.view === "workspace" && S.sel === p.id}" title="${esc(p.use)} · ${STATUS[st].label()}">
          <span class="plate">${p.name}</span><span class="lamp lamp-${st}"></span><span class="pb-imb">${p.audit ? pct(live(p).imb) : "—"}</span></button>`;
      }).join("");
      return `<div class="pb-level"><div class="pb-level-name">${level}</div>${items}</div>`;
    }).join("");
    return `<div class="pb-head">Panels</div>${lv}`;
  }

  // ---------------------------------------------------------------- audit view
  function nextStep() {
    const t = S.cfg.target, N = S.panels.length;
    if (!S.panels.some((p) => p.audit)) return { text: `Check all ${N} panels against the ${t}% target. Nothing in the model changes.`, act: "run-audit", label: "Run audit", icon: "scan" };
    const flagged = flaggedPanels().filter((p) => !p.proposal);
    if (flagged.length) return { text: `${flagged.length} ${flagged.length === 1 ? "panel is" : "panels are"} over ${t}%. Let the copilot find the fewest circuit moves for each.`, act: "balance-all", label: "Find fixes", icon: "bolt" };
    const pend = pendingPanels().length;
    if (pend) return { text: `${pend} ${pend === 1 ? "fix is" : "fixes are"} ready. Check them in the list below, then accept the ones you agree with.`, act: "accept-all", label: `Accept all ${pend}`, icon: "check" };
    const acc = acceptedPanels().length;
    if (acc) return { text: `${acc} ${acc === 1 ? "fix" : "fixes"} accepted. Apply ${acc === 1 ? "it" : "them"} to the model; every change can be undone.`, act: "apply-accepted", label: `Apply ${acc === 1 ? "fix" : "fixes"}`, icon: "check" };
    const within = S.panels.filter((p) => live(p).imb <= t).length;
    const k = S.panels.filter((p) => p.proposal && p.review !== "applied" && ["needs", "locked"].includes(p.proposal.status)).length;
    return { text: `${within} of ${N} panels are within ${t}%.${k ? ` ${k} ${k === 1 ? "needs" : "need"} an engineer's decision; the list below says why.` : ""}`, act: "view", id: "report", label: "Open the report", icon: "report", plain: true };
  }

  function viewIntro() {
    return `<div class="card intro">
      <div>
        <h2>How phase balancing works</h2>
        <ol>
          <li>A panel feeds its circuits from three phases: A, B and C. The row a breaker sits in decides its phase.</li>
          <li>When one phase carries much more load than the others, the panel is out of balance. Cables and the neutral run hotter.</li>
          <li>The copilot finds the fewest breakers to move to even it out. An engineer approves every change.</li>
        </ol>
        <div class="intro-foot">
          <button class="btn btn-sm" data-act="intro-hide">Got it</button>
          ${S.tour.on ? "" : `<button class="btn btn-sm btn-ghost" data-act="tour-start">${icon("play")} Watch the guided dry run</button>`}
        </div>
      </div>
      <div class="intro-viz" aria-hidden="true">
        <figure><div class="bars"><i class="ph-A" style="height:100%"></i><i class="ph-B" style="height:64%"></i><i class="ph-C" style="height:44%"></i></div><figcaption>Out of balance</figcaption></figure>
        <figure><div class="bars"><i class="ph-A" style="height:78%"></i><i class="ph-B" style="height:75%"></i><i class="ph-C" style="height:81%"></i></div><figcaption>Balanced</figcaption></figure>
      </div>
    </div>`;
  }

  function viewNext() {
    const ns = nextStep();
    return `<div class="next" role="region" aria-label="Next step"><span class="next-k">Next step</span><p>${esc(ns.text)}</p>
      <button class="btn ${ns.plain ? "btn-plain" : "btn-primary"}" id="next-btn" data-act="${ns.act}" data-id="${ns.id || ""}">${icon(ns.icon)} ${ns.label}</button></div>`;
  }

  function viewStats() {
    const audited = S.panels.filter((p) => p.audit);
    const over = audited.filter((p) => p.audit.imb > S.cfg.target).length;
    const fixed = S.panels.filter((p) => p.review === "applied").length;
    return `<div class="stats">
      <div class="card stat"><span class="stat-v">${audited.length}</span><span class="stat-k">panels checked</span></div>
      <div class="card stat"><span class="stat-v ${over ? "tx-alarm" : "tx-fix"}">${over}</span><span class="stat-k">over ${S.cfg.target}%</span></div>
      <div class="card stat"><span class="stat-v ${fixed ? "tx-fix" : ""}">${fixed}</span><span class="stat-k">fixed</span></div>
    </div>`;
  }

  function viewAudit() {
    const sum = auditSummary();
    return `<section class="view" aria-labelledby="h-audit">
      <div class="view-head"><div>
        <p class="eyebrow">Whole building</p>
        <h1 id="h-audit">Project audit</h1>
        <p class="lede">Checks the three phases of every panel and flags any panel more than ${S.cfg.target}% out of balance.</p>
      </div></div>
      ${S.intro ? viewIntro() : ""}
      ${viewNext()}
      ${sum ? viewStats() : ""}
      ${viewRiser()}
      ${sum ? viewAttention() : ""}
      ${sum ? viewAuditTable() : ""}
    </section>`;
  }

  function miniBars(L, known) {
    const max = Math.max(L.A, L.B, L.C) || 1;
    return `<span class="mini ${known ? "" : "unknown"}" aria-hidden="true">${PHASES.map((ph) => `<i class="ph-${ph}" style="height:${(L[ph] / max * 100).toFixed(1)}%"></i>`).join("")}</span>`;
  }

  function viewRiser() {
    const order = SP.levels.slice().reverse();
    const storeys = SP.levels.map((level) => {
      const fromBottom = order.indexOf(level);
      const cards = S.panels.filter((p) => p.level === level).map((p, i) => {
        const st = panelStatus(p);
        const a = live(p);
        const after = p.proposal && p.review !== "applied" && p.proposal.changes.length ? ` <small>→ ${pct(p.proposal.afterImb)}</small>` : "";
        const d = 260 + fromBottom * 430 + i * 110;
        return `<button class="rcard" data-act="open-panel" data-id="${p.id}" style="--d:${d}ms" aria-label="${p.name}, ${STATUS[st].label()}">
          <span class="plate">${p.name}</span>
          ${miniBars(a.loads, !!p.audit)}
          <span class="rcard-imb">${p.audit ? pct(a.imb) + after : "—"}</span>
          ${chip(st)}
          ${isStale(p) ? `<span class="stale" title="The model changed after the last audit">changed</span>` : ""}
          ${S.anim.audit ? `<span class="cover">reading…</span>` : ""}
        </button>`;
      }).join("");
      return `<div class="storey"><div class="storey-tag"><b>${level}</b><span>FFL ${FFL[level]} m</span></div><div class="storey-run">${cards}</div></div>`;
    }).join("");
    return `<div class="card riser ${S.anim.audit ? "scanning" : ""}">
      <div class="card-h"><h2>Building riser</h2><span class="card-sub">Tap a panel to open it</span></div>
      <div class="riser-body">
        ${storeys}
        <div class="storey"><div class="storey-tag"><b>LV room</b><span>Level 01</span></div>
          <div class="storey-run"><div class="mdb"><span class="plate">MDB-01</span><span>Main board · fed from TX-01, 1000 kVA</span></div></div></div>
        <div class="scanline" aria-hidden="true"></div>
      </div>
    </div>`;
  }

  function panelLine(p) {
    const st = panelStatus(p), pr = p.proposal, a = live(p), t = S.cfg.target;
    const firstSentence = (s) => (s || "").split(". ")[0].replace(/\.$/, "") + ".";
    switch (st) {
      case "over": return `${pct(a.imb)} out of balance. Phase ${heaviest(a.loads).ph} is furthest from the average.`;
      case "proposed": return `Move ${plural(pr.changes.length, "circuit")} to bring it from ${pct(pr.beforeImb)} to ${pct(pr.afterImb)}.`;
      case "accepted": return `Accepted. ${plural(pr.changes.length, "circuit")} will move, taking it to ${pct(pr.afterImb)}.`;
      case "rejected": return `Rejected. Left as drawn at ${pct(a.imb)}.`;
      case "needs": return `Can't reach ${t}%. Best possible is ${pct(pr.afterImb)}. ${firstSentence(pr.reason)}`;
      case "locked": return `Locked circuits stop it reaching ${t}%. Best possible with the locks is ${pct(pr ? pr.afterImb : a.imb)}.`;
      case "applied": { const tx = S.tx.find((x) => x.panelId === p.id && !x.undone); return `Fixed: ${pct(p.audit.baseline)} → ${pct(a.imb)}, ${plural(tx ? tx.changes : 0, "circuit")} moved.`; }
      default: return "";
    }
  }

  function viewAttention() {
    const items = S.panels.filter((p) => p.audit && !["ok", "unknown"].includes(panelStatus(p))).sort((a, b) => b.audit.baseline - a.audit.baseline);
    const okList = S.panels.filter((p) => p.audit && panelStatus(p) === "ok");
    const rows = items.map((p) => {
      const st = panelStatus(p);
      const view = `<button class="btn btn-sm btn-ghost" data-act="open-panel" data-id="${p.id}">Open</button>`;
      let acts = view;
      if (st === "proposed") acts = `<button class="btn btn-sm btn-primary" data-act="accept" data-id="${p.id}">${icon("check")} Accept</button><button class="btn btn-sm" data-act="reject" data-id="${p.id}">Reject</button>${view}`;
      else if (st === "accepted") acts = `<button class="btn btn-sm" data-act="unreview" data-id="${p.id}">Undo accept</button>${view}`;
      else if (st === "rejected") acts = `<button class="btn btn-sm" data-act="unreview" data-id="${p.id}">Reconsider</button>${view}`;
      else if (st === "applied") { const t = S.tx.find((x) => x.panelId === p.id && !x.undone); acts = `${t ? `<button class="btn btn-sm" data-act="undo" data-id="${t.id}">${icon("undo")} Undo</button>` : ""}${view}`; }
      return `<li><span class="plate">${p.name}</span><div class="att-body">${chip(st)}<span class="att-line">${esc(panelLine(p))}</span></div><div class="actions">${acts}</div></li>`;
    }).join("");
    return `<div class="card">
      <div class="card-h"><h2>Panels to look at</h2><span class="card-sub">${items.length} of ${S.panels.length}</span></div>
      ${rows ? `<ul class="att">${rows}</ul>` : `<div class="empty-state"><p>Every panel is within ${S.cfg.target}%.</p></div>`}
      ${okList.length ? `<div class="att-ok">${icon("check")}<span>${okList.length} ${okList.length === 1 ? "panel is" : "panels are"} already within ${S.cfg.target}%: ${okList.map((p) => p.name).join(", ")}.</span></div>` : ""}
    </div>`;
  }

  function viewAuditTable() {
    const k = S.sort.key, dir = S.sort.dir;
    const val = (p) => { const a = live(p); return k === "name" ? p.name : k === "level" ? SP.levels.length - SP.levels.indexOf(p.level) : PHASES.includes(k) ? a.loads[k] : a.imb; };
    const rows = S.panels.slice().sort((a, b) => { const va = val(a), vb = val(b); return (va > vb ? 1 : va < vb ? -1 : 0) * dir; });
    const th = (key, label, r) => `<th class="${r ? "r" : ""}"><button class="sort-btn" data-act="sort" data-id="${key}" data-active="${k === key}">${label}${k === key ? (dir > 0 ? " ▲" : " ▼") : ""}</button></th>`;
    const body = rows.map((p) => { const a = live(p); return `<tr>
      <td><button class="link-btn" data-act="open-panel" data-id="${p.id}">${p.name}</button></td><td>${p.level}</td>
      ${PHASES.map((ph) => `<td class="num r">${fmt(a.loads[ph])}</td>`).join("")}
      <td class="num r"><b>${pct(a.imb)}</b></td><td>${chip(panelStatus(p))}${p.audit && p.audit.zero ? ` <span class="chip chip-needs">${icon("alert")}${plural(p.audit.zero, "circuit")} at 0 VA</span>` : ""}</td></tr>`; }).join("");
    return `<details class="card-more more" id="d-table" ${openAttr("d-table", false)}>
      <summary>All panels in numbers <span class="sum-val">VA per phase</span></summary>
      <div class="tw"><table class="tbl"><thead><tr>${th("name", "Panel")}${th("level", "Level")}${th("A", "Phase A", 1)}${th("B", "Phase B", 1)}${th("C", "Phase C", 1)}${th("imb", "Imbalance", 1)}<th>Status</th></tr></thead><tbody>${body}</tbody></table></div>
    </details>`;
  }

  // ---------------------------------------------------------------- panel workspace
  function wsState(p) {
    const pr = p.proposal;
    const cur = live(p);
    if (p.review === "applied" && pr) return { mode: "applied", pr, cur, circuits: p.circuits, before: pr.before, beforeImb: pr.beforeImb, after: cur.loads, afterImb: cur.imb };
    if (pr && S.boardMode === "proposed" && pr.changes.length) return { mode: "proposed", pr, cur, circuits: pr.newCircuits, before: cur.loads, beforeImb: cur.imb, after: pr.after, afterImb: pr.afterImb };
    return { mode: "drawn", pr, cur, circuits: p.circuits, before: cur.loads, beforeImb: cur.imb, after: null, afterImb: null };
  }

  function panelSentence(p, W) {
    const t = S.cfg.target;
    if (W.mode === "applied") return `Fixed. Imbalance went from <b>${pct(W.beforeImb)}</b> to <b>${pct(W.afterImb)}</b>.`;
    if (W.mode === "proposed") return `With this fix every phase sits within <b>${pct(W.afterImb)}</b> of the average, down from <b>${pct(W.beforeImb)}</b>.`;
    const a = W.cur;
    if (!(a.total > 0)) return "This panel has no load yet.";
    const h = heaviest(a.loads);
    if (a.imb <= t) return `All three phases sit within <b>${pct(a.imb)}</b> of the ${fmt(h.avg)} VA average. That is inside the ${t}% target, so nothing needs to move.`;
    return `Phase ${h.ph} carries ${h.dev < 0 ? "only " : ""}<b>${fmt(h.L)} VA</b> against an average of <b>${fmt(h.avg)} VA</b>, so the panel is <b>${pct(a.imb)}</b> out of balance. The target is ${t}% or less.`;
  }

  function viewWorkspace() {
    const p = panel(S.sel);
    const W = wsState(p);
    const st = panelStatus(p);
    const pr = W.pr;
    const V = PM.VOLTAGES[S.cfg.voltage];
    const canToggle = pr && pr.changes.length && p.review !== "applied";
    const pick = `<label class="panel-pick"><span class="ctl-label">Panel</span><select id="panel-pick">${S.panels.map((q) => `<option value="${q.id}" ${q.id === p.id ? "selected" : ""}>${q.name} · ${STATUS[panelStatus(q)].label()}</option>`).join("")}</select></label>`;
    return `<section class="view" aria-labelledby="h-ws">
      <div class="ws-head">
        <div class="ws-title">
          <h1 id="h-ws" class="sr">Panel ${p.name}</h1>
          <span class="plate plate-xl">${p.name}</span>
          <div><div class="ws-note">${esc(p.note || p.use)}</div><div class="ws-spec">${V.label} · ${p.ways}-way · ${p.level} · fed from ${esc(p.fedFrom)}</div></div>
        </div>
        <div class="actions" style="align-items:center">${chip(st)}${isStale(p) ? `<span class="chip chip-needs">${icon("change")}Changed since audit</span>` : ""}${pick}</div>
      </div>
      <p class="ws-sentence">${panelSentence(p, W)}</p>
      <div class="card">
        <div class="actionbar">
          <button class="btn btn-primary" id="run-copilot" data-act="run-copilot">${icon("bolt")} Find the fewest moves</button>
          <div class="ctl"><label class="ctl-label" for="target">Target</label><input type="range" id="target" min="5" max="15" step="1" value="${S.cfg.target}"><output id="target-out" for="target">${S.cfg.target}%</output></div>
          <button class="btn btn-ghost" id="opts-btn" data-act="toggle-opts" aria-expanded="${S.opts}">${S.opts ? "Fewer options" : "More options"}</button>
        </div>
        ${S.opts ? `<div class="opts">
          <div class="ctl"><span class="ctl-label" id="lbl-appr">Method</span><div class="seg" role="group" aria-labelledby="lbl-appr">
            <button id="appr-mm" aria-pressed="${S.cfg.approach === "min_move"}" data-act="approach" data-id="min_move">Fewest moves</button>
            <button id="appr-lpt" aria-pressed="${S.cfg.approach === "lpt"}" data-act="approach" data-id="lpt">Fresh layout</button></div></div>
          <div class="ctl"><span class="ctl-label" id="lbl-basis">Load basis</span><div class="seg" role="group" aria-labelledby="lbl-basis">
            <button id="basis-c" aria-pressed="${S.cfg.basis === "connected"}" data-act="basis" data-id="connected">Connected</button>
            <button id="basis-d" aria-pressed="${S.cfg.basis === "demand"}" data-act="basis" data-id="demand">Demand</button></div></div>
          <button class="btn" id="design-btn" data-act="design-change" title="Change one circuit's load, as happens during design">${icon("change")} Simulate a design change</button>
        </div>` : ""}
      </div>
      <div class="ws-grid">
        <div class="card">
          <div class="card-h"><h2>Panelboard</h2>
            <div class="seg small" role="group" aria-label="Layout shown">
              <button id="bm-drawn" aria-pressed="${W.mode !== "proposed"}" data-act="board-mode" data-id="drawn">${p.review === "applied" ? "As applied" : "As drawn"}</button>
              <button id="bm-prop" aria-pressed="${W.mode === "proposed"}" data-act="board-mode" data-id="proposed" ${canToggle ? "" : "disabled"}>With fix</button>
            </div>
            <div class="seg small" role="group" aria-label="Drawing style">
              <button id="bs-board" aria-pressed="${S.boardStyle === "board"}" data-act="board-style" data-id="board">Board</button>
              <button id="bs-sched" aria-pressed="${S.boardStyle === "schedule"}" data-act="board-style" data-id="schedule">Table</button>
            </div>
          </div>
          ${S.boardStyle === "board" ? viewBoard(p, W) : viewSchedule(p, W)}
          <div class="board-legend">
            <span><i class="lg-box locked"></i>Locked</span><span><i class="lg-box pending"></i>Will move</span><span><i class="lg-box moved"></i>Moved</span>
            <span>Tap a breaker for details, or its padlock to lock it.</span>
          </div>
        </div>
        <div class="ws-side">
          ${viewBalance(p, W)}
          ${viewPhasor(p, W)}
          ${S.selCircuit ? viewInspector(p) : ""}
        </div>
      </div>
      ${viewReview(p, W)}
    </section>`;
  }

  function marks(p, W) {
    const moved = new Map(), ghosts = new Map(), pending = new Map();
    if (!W.pr) return { moved, ghosts, pending };
    if (W.mode === "drawn") { for (const ch of W.pr.changes) pending.set(ch.id, ch); return { moved, ghosts, pending }; }
    for (const ch of W.pr.changes) moved.set(ch.id, ch);
    const occ = new Set();
    for (const c of W.circuits) for (const s of PM.slotsOf(c)) occ.add(s);
    for (const ch of W.pr.changes) if (!occ.has(ch.fromSlot)) ghosts.set(ch.fromSlot, ch);
    return { moved, ghosts, pending };
  }

  function viewBoard(p, W) {
    const rows = Math.ceil(p.ways / 2);
    const M = marks(p, W);
    const occ = new Map();
    for (const c of W.circuits) for (const s of PM.slotsOf(c)) occ.set(s, c);
    const evalIds = S.anim.eval ? new Set(PM.toCore(p, S.cfg).filter(PB.isMovable).map((c) => c.number)) : null;
    let cells = "", ev = 0;
    for (let s = 1; s <= p.ways; s++) {
      const c = occ.get(s);
      const odd = s % 2 === 1;
      const pos = `grid-row:${PM.rowOfSlot(s)} / span ${c && c.slot === s ? c.poles : 1};grid-column:${odd ? 1 : 3}`;
      if (!c) {
        const g = M.ghosts.get(s);
        cells += `<div class="space ${odd ? "L" : "R"} ${g ? "ghost" : ""}" style="${pos}">${g ? `<span class="g-long">Moved to slot ${g.toSlot}</span><span class="g-short">→ ${g.toSlot}</span>` : `<span class="sp-word">Space</span>`}<span>${s}</span></div>`;
        continue;
      }
      if (c.slot !== s) continue;
      const phs = PM.phasesOf(c);
      const locked = PM.isLocked(c, S.cfg);
      const mv = M.moved.get(c.id), pd = M.pending.get(c.id);
      const va = PM.basisVA(c, S.cfg);
      const cls = ["brk", odd ? "L" : "R", c.spare ? "spare" : "", c.poles > 1 ? "multi" : "", locked ? "locked" : "", mv ? "moved" : "", pd ? "pending" : "", S.selCircuit === c.id ? "sel" : "", !c.spare && !(c.va > 0) ? "zero" : "", evalIds && evalIds.has(c.slot) ? "eval" : ""].filter(Boolean).join(" ");
      const lockTitle = c.lockedSlot && S.cfg.respectLocks ? "Locked slot. Tap to unlock." : c.doNotMove ? "Locked (DoNotMove). Tap to unlock." : "Tap to lock this circuit";
      const meta = c.spare ? "no load" : `${c.poles}-pole · ${CLS[c.cls]}${!(c.va > 0) ? " · no load set" : ""}`;
      const vaHtml = c.spare ? "" : `<span class="brk-va"><b>${fmt(va)}</b><small>VA</small></span>`;
      const tag = mv ? `<span class="was">was ${mv.fromSlot}<span class="hide-m"> · ${mv.fromPhase}→${mv.toPhase}</span></span>` : pd ? `<span class="pend">→ ${pd.toSlot}</span>` : "";
      const d = evalIds && evalIds.has(c.slot) ? `--d:${(ev++) * 70}ms;` : "";
      cells += `<div class="${cls}" data-cid="${c.id}" data-act="pick-circuit" data-id="${c.id}" role="button" tabindex="0" style="${d}${pos}" aria-label="Circuit ${c.slot}, ${esc(c.spare ? "spare" : c.name)}, ${fmt(va)} VA, phase ${phs.join(" ")}${locked ? ", locked" : ""}">
        <span class="brk-no">${c.slot}</span>
        <span class="brk-body"><span class="brk-name" title="${esc(c.spare ? "Spare" : c.name)}">${esc(c.spare ? "Spare" : c.name)}</span><span class="brk-meta">${meta}</span></span>
        ${vaHtml}${tag}
        ${c.spare || c.poles > 1 ? "" : `<button class="brk-lock ${locked ? "on" : ""}" data-act="toggle-lock" data-id="${c.id}" aria-pressed="${locked}" title="${lockTitle}" aria-label="${lockTitle}">${icon(locked ? "lock" : "unlock")}</button>`}
        <span class="brk-handle">${phs.map((ph) => `<i class="ph-${ph}"></i>`).join("")}</span>
      </div>`;
    }
    return `<div class="board-wrap"><div class="board-frame">
      <div class="board-headrow"><span>Odd slots</span><span class="bus-labels"><b class="ph-A">A</b><b class="ph-B">B</b><b class="ph-C">C</b></span><span>Even slots</span></div>
      <div class="board" style="grid-template-rows:repeat(${rows}, var(--row))">${busSvg(rows, occ)}${cells}</div>
    </div></div>`;
  }

  function busSvg(rows, occ) {
    const rh = 50, gap = 4, H = rows * rh + (rows - 1) * gap, W = 120;
    const X = { A: 36, B: 60, C: 84 };
    let taps = "", studs = "";
    for (let r = 1; r <= rows; r++) {
      const ph = PM.phaseOfSlot(2 * r - 1);
      const y = (r - 1) * (rh + gap) + rh / 2;
      taps += `<line class="tap ${ph} ${occ.get(2 * r - 1) ? "" : "faint"}" x1="0" y1="${y}" x2="${X[ph]}" y2="${y}"/>`;
      taps += `<line class="tap ${ph} ${occ.get(2 * r) ? "" : "faint"}" x1="${X[ph]}" y1="${y}" x2="${W}" y2="${y}"/>`;
      studs += `<rect class="stud ${ph}" x="${X[ph] - 7}" y="${y - 5}" width="14" height="10" rx="2"/>`;
    }
    const bars = PHASES.map((ph) => `<rect class="bar" x="${X[ph] - 4}" y="-6" width="8" height="${H + 12}" rx="2"/>`).join("");
    return `<svg class="bus" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${taps}${bars}${studs}</svg>`;
  }

  function viewSchedule(p, W) {
    const rows = Math.ceil(p.ways / 2);
    const M = marks(p, W);
    const occ = new Map();
    for (const c of W.circuits) for (const s of PM.slotsOf(c)) occ.set(s, c);
    const side = (s) => {
      const c = occ.get(s);
      if (!c) { const g = M.ghosts.get(s); return { ckt: s, desc: g ? `<span class="tx-fix">moved to ${g.toSlot}</span>` : `<span class="muted">Space</span>`, va: "", share: 0, moved: false }; }
      const share = PM.basisVA(c, S.cfg) / c.poles;
      if (c.slot !== s) return { ckt: s, desc: `<span class="muted">↳ part of ${c.slot}</span>`, va: "", share, moved: false };
      const mv = M.moved.get(c.id), pd = M.pending.get(c.id);
      return { ckt: s, desc: `${esc(c.spare ? "Spare" : c.name)}${PM.isLocked(c, S.cfg) ? ` ${icon("lock")}` : ""}${mv ? ` <span class="was">was ${mv.fromSlot}</span>` : pd ? ` <span class="pend">→ ${pd.toSlot}</span>` : ""}`, va: c.spare ? "" : fmt(PM.basisVA(c, S.cfg)), share, moved: !!mv };
    };
    let body = "";
    for (let r = 1; r <= rows; r++) {
      const ph = PM.phaseOfSlot(2 * r - 1);
      const L = side(2 * r - 1), R = side(2 * r);
      const pc = PHASES.map((q) => q === ph ? `<td class="pc live ph-${q}">${L.share || R.share ? `${L.share ? fmt(L.share) : "–"} | ${R.share ? fmt(R.share) : "–"}` : "–"}</td>` : `<td class="pc"></td>`).join("");
      body += `<tr><td class="ckt">${L.ckt}</td><td class="desc ${L.moved ? "side-moved" : ""}">${L.desc}</td><td class="va">${L.va}</td>${pc}<td class="va">${R.va}</td><td class="desc ${R.moved ? "side-moved" : ""}">${R.desc}</td><td class="ckt">${R.ckt}</td></tr>`;
    }
    const loads = W.mode === "proposed" ? W.after : live(p).loads;
    return `<div class="sched-wrap"><table class="sched">
      <thead><tr><th>Ckt</th><th>Description</th><th class="r">VA</th><th class="pc ph-A">A</th><th class="pc ph-B">B</th><th class="pc ph-C">C</th><th class="r">VA</th><th>Description</th><th>Ckt</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td colspan="3">Total per phase (VA)</td>${PHASES.map((q) => `<td class="pc">${fmt(loads[q])}</td>`).join("")}<td colspan="3">Imbalance ${pct(PB.imbalancePct(loads))}</td></tr></tfoot>
    </table></div>`;
  }

  function vizMemo(p) { return S.viz[p.id] || (S.viz[p.id] = {}); }

  function viewBalance(p, W) {
    const memo = vizMemo(p);
    const showAfter = W.mode !== "drawn";
    const val = showAfter ? W.afterImb : W.beforeImb;
    const from = memo.imb == null ? val : memo.imb;
    const t = S.cfg.target;
    const shown = showAfter ? W.after : W.before;
    const avg = (shown.A + shown.B + shown.C) / 3;
    const tf = t / 100;
    const max = Math.max(W.before.A, W.before.B, W.before.C, showAfter ? Math.max(W.after.A, W.after.B, W.after.C) : 0, avg * (1 + tf)) * 1.06 || 1;
    const x = (v) => `${(v / max * 100).toFixed(2)}%`;
    const prevW = memo.bars || {};
    const rows = PHASES.map((ph) => {
      const w = x(shown[ph]);
      return `<div class="pl-row ph-${ph}"><span class="pl-tag">${ph}</span><div class="pl-main">
        <div class="pl-track"><span class="pl-band" style="left:${x(avg * (1 - tf))};width:${x(avg * 2 * tf)}"></span>
          ${showAfter ? `<span class="pl-before" style="width:${x(W.before[ph])}"></span>` : ""}
          <span class="pl-bar" data-w="${w}" style="width:${prevW[ph] || w}"></span><span class="pl-avg" style="left:${x(avg)}"></span></div>
        <div class="pl-vals">${showAfter ? `${fmt(W.before[ph])} → <b>${fmt(W.after[ph])}</b>` : `<b>${fmt(W.before[ph])}</b>`} VA · ${showAfter ? `${amp(W.before[ph])} → <b>${amp(W.after[ph])}</b>` : `<b>${amp(W.before[ph])}</b>`} A</div>
      </div></div>`;
    }).join("");
    memo.barsNext = Object.fromEntries(PHASES.map((ph) => [ph, x(shown[ph])]));
    return `<div class="card bal">
      <div class="bal-top">
        ${showAfter ? `<div><span class="k">Before</span><span class="imb-before">${pct(W.beforeImb)}</span></div><span class="imb-arrow">${icon("arrow")}</span>` : ""}
        <div><span class="k">${showAfter ? (W.mode === "applied" ? "Now" : "With fix") : "Out of balance"}</span>
          <span class="imb-big ${val > t ? "tx-alarm" : "tx-fix"}" data-tween-from="${from}" data-tween-to="${val}">${pct(val)}</span></div>
      </div>
      <p class="bal-note">The gap between the busiest phase and the average. Target: ${t}% or less.</p>
      <div class="pl">${rows}</div>
      <div class="pl-foot">
        <span><i class="lg-box" style="background:var(--fix-soft);border-color:var(--fix)"></i>Every bar should end in the green band</span>
        <span><i style="display:inline-block;width:0;height:12px;border-left:1.5px dashed var(--ink-2)"></i>Average</span>
      </div>
    </div>`;
  }

  function onePoleLoadsOf(p, circuits) { return PM.onePoleLoads({ ways: p.ways, circuits }, S.cfg); }
  function panelBefore(p) { const t = S.tx.find((x) => x.panelId === p.id && !x.undone); return t ? t.prev : p.circuits; }

  function viewPhasor(p, W) {
    const vln = PM.VOLTAGES[S.cfg.voltage].ln;
    const showAfter = W.mode !== "drawn";
    const beforeL = W.mode === "applied" ? onePoleLoadsOf(p, panelBefore(p)) : onePoleLoadsOf(p, p.circuits);
    const afterL = showAfter ? onePoleLoadsOf(p, W.mode === "applied" ? p.circuits : W.circuits) : null;
    const shown = showAfter ? afterL : beforeL;
    const In = PM.neutralCurrent(shown, vln), In0 = PM.neutralCurrent(beforeL, vln);
    const cur = { a: shown.A / vln, b: shown.B / vln, c: shown.C / vln };
    const scaleMax = Math.max(beforeL.A, beforeL.B, beforeL.C, afterL ? Math.max(afterL.A, afterL.B, afterL.C) : 0) / vln || 1;
    return `<details class="card-more more" id="d-neutral" ${openAttr("d-neutral", false)}>
      <summary>Neutral current <span class="sum-val">${showAfter ? `${In0.toFixed(1)} → ` : ""}${In.toFixed(1)} A</span></summary>
      <div class="phasor-wrap">
        <svg class="phasor" id="phasor" viewBox="-100 -100 200 200" data-a="${cur.a}" data-b="${cur.b}" data-c="${cur.c}" data-max="${scaleMax}" role="img" aria-label="Phasor diagram. Estimated neutral current ${In.toFixed(1)} amps.">
          <circle class="ring" r="78"/><circle class="ring" r="39"/>
          <line class="axis" x1="0" y1="0" x2="0" y2="-88"/><line class="axis" x1="0" y1="0" x2="76" y2="44"/><line class="axis" x1="0" y1="0" x2="-76" y2="44"/>
          <g id="ph-vecs"></g>
        </svg>
        <p class="hint">When the three phases are equal they cancel on the neutral. Any imbalance returns along it as extra current. Estimated from single-pole loads at unity power factor.</p>
      </div>
    </details>`;
  }

  function drawPhasor(svg, v, max) {
    const R = 78;
    const ang = { a: -90, b: 30, c: 150 };
    const pt = (k, mag) => { const r = (mag / max) * R, th = ang[k] * Math.PI / 180; return [r * Math.cos(th), r * Math.sin(th)]; };
    const arrow = (x, y, cls, label) => {
      const len = Math.hypot(x, y);
      if (len < 0.5) return `<circle class="head ${cls}" r="3"/>`;
      const ux = x / len, uy = y / len, hx = x - ux * 7, hy = y - uy * 7, px = -uy * 4.5, py = ux * 4.5;
      return `<line class="vec ${cls}" x1="0" y1="0" x2="${hx.toFixed(2)}" y2="${hy.toFixed(2)}"/>` +
        `<path class="head ${cls}" d="M${x.toFixed(2)},${y.toFixed(2)} L${(hx + px).toFixed(2)},${(hy + py).toFixed(2)} L${(hx - px).toFixed(2)},${(hy - py).toFixed(2)} Z"/>` +
        (label ? `<text x="${(x + ux * 11).toFixed(1)}" y="${(y + uy * 11 + 4).toFixed(1)}" text-anchor="middle">${label}</text>` : "");
    };
    const A = pt("a", v.a), B = pt("b", v.b), C = pt("c", v.c);
    const N = [A[0] + B[0] + C[0], A[1] + B[1] + C[1]];
    svg.querySelector("#ph-vecs").innerHTML = arrow(A[0], A[1], "A", "A") + arrow(B[0], B[1], "B", "B") + arrow(C[0], C[1], "C", "C") + arrow(N[0], N[1], "N", Math.hypot(N[0], N[1]) > 6 ? "N" : "");
  }

  function viewInspector(p) {
    const c = p.circuits.find((x) => x.id === S.selCircuit);
    if (!c) return "";
    const sheets = (c.sheets || []).map((s) => `<span class="sheet-tag ${s.issued ? "issued" : ""}" title="${esc(s.title)}">${s.id} ${s.issued ? "issued" : "not issued"}</span>`).join("");
    const lockable = !c.spare && c.poles === 1;
    return `<div class="card">
      <div class="card-h"><h2>Circuit ${c.slot}</h2><button class="btn btn-sm btn-ghost" data-act="close-insp">Close</button></div>
      <div class="insp">
        <p><b>${esc(c.spare ? "Spare breaker" : c.name)}</b></p>
        <dl class="insp-grid">
          <dt>Phase</dt><dd>${PM.phasesOf(c).map(phtag).join(" ")} · ${c.poles}-pole${c.poles > 1 ? " (never moves)" : ""}</dd>
          ${c.spare ? "" : `<dt><label for="insp-va">Load</label></dt><dd><input type="number" id="insp-va" min="0" step="50" value="${c.va}"> VA</dd>`}
          ${lockable ? `<dt>Lock</dt><dd style="display:flex;flex-direction:column;gap:8px">
            <label class="check"><input type="checkbox" id="insp-dnm" ${c.doNotMove ? "checked" : ""}> Do not move</label>
            <label class="check"><input type="checkbox" id="insp-ls" ${c.lockedSlot ? "checked" : ""}> Locked slot</label></dd>` : ""}
          ${sheets ? `<dt>Drawings</dt><dd>${sheets}</dd>` : ""}
        </dl>
      </div>
    </div>`;
  }

  function describeStep(st) {
    if (st.kind === "move") return `move circuit ${st.numbers[0]} from ${st.from[0]} to ${st.to[0]}`;
    return `swap circuits ${st.numbers[0]} and ${st.numbers[1]} (${st.from[0]} ↔ ${st.from[1]})`;
  }

  function viewTrace(p, pr) {
    const reveal = !!S.anim.trace;
    let items = "", d = 0;
    const li = (html, cls) => `<li class="${cls || ""} ${reveal ? "reveal" : ""}" style="--d:${(d++) * 380}ms">${html}</li>`;
    if (pr.approach === "lpt") {
      items += li(`Sorted the movable circuits by load, largest first.`);
      items += li(`Put each one on whichever phase was lightest, ignoring where it was drawn.`);
      items += li(`Result ${pct(pr.afterImb)}, with ${plural(pr.changes.length, "circuit")} renumbered.`, "stop");
    } else {
      const T = pr.trace;
      if (!T.length) items += li(`Already within the ${pr.target}% target. Nothing to search.`, "stop");
      for (const t of T) {
        const tried = `Tried ${t.evaluatedMoves} single moves and ${t.evaluatedSwaps} swaps${t.blockedByCapacity ? ` (${t.blockedByCapacity} moves skipped: no free slot on that phase)` : ""}.`;
        if (t.step) items += li(`<b>${pct(t.before)} out of balance.</b> ${tried} Best: ${describeStep(t.step)}, giving ${pct(t.step.after)}.`);
        else items += li(`<b>${pct(t.before)} out of balance.</b> ${tried} None of them helps.`);
      }
      const why = { "target met": `the ${pr.target}% target is met`, "no improving move": "no move or swap helps any further", "iteration limit": "iteration limit reached" }[T.stopReason] || T.stopReason;
      if (T.length) items += li(`Stopped because ${why}.`, "stop");
    }
    return `<details class="card-more more trace" id="d-trace" ${openAttr("d-trace", false)}>
      <summary>How the copilot searched <span class="sum-val">${pr.approach === "lpt" ? "fresh layout" : plural(pr.trace.length, "step")}</span></summary>
      <ol>${items}</ol>
      <p class="hint note">Each option is scored by how much balance it gains per circuit renumbered, so a swap counts as two. The summary above comes from a fixed template; in production an approved AI model may word it, but it never calculates loads or chooses moves.</p>
    </details>`;
  }

  function explain(p, pr) {
    const L = pr.before;
    const { ph: hp, dev: hd, avg } = heaviest(L);
    if (pr.status === "ok" && pr.approach !== "lpt") return `${p.name} sits at ${pct(pr.beforeImb)}, inside the ${pr.target}% target. No circuits need to move.`;
    const origin = p.review === "applied" ? panelBefore(p) : p.circuits;
    let s = `Phase ${hp} carried ${fmt(L[hp])} VA, ${fmt(Math.abs(hd))} VA ${hd > 0 ? "above" : "below"} the ${fmt(avg)} VA average.`;
    const ones = origin.filter((c) => !c.spare && c.poles === 1).sort((a, b) => b.va - a.va);
    if (hd > 0 && ones[0] && PM.phaseOfSlot(ones[0].slot) === hp) s += ` It holds the biggest single-pole load, ${ones[0].name} (${fmt(ones[0].va)} VA).`;
    const ch = pr.changes;
    if (ch.length === 1) s += ` Moving ${ch[0].name} from phase ${ch[0].fromPhase} to phase ${ch[0].toPhase} brings every phase within ${pct(pr.afterImb)} of the average. No other circuit changes.`;
    else if (ch.length === 2 && ch[0].kind === "swap") s += ` Swapping ${ch[0].name} (phase ${ch[0].fromPhase}) with ${ch[1].name} (phase ${ch[1].fromPhase}) brings every phase within ${pct(pr.afterImb)} of the average.`;
    else if (ch.length) s += ` Moving ${ch.length} circuits brings every phase within ${pct(pr.afterImb)} of the average.`;
    const locked = origin.filter((c) => !c.spare && c.poles === 1 && PM.isLocked(c, S.cfg));
    if (locked.length && ch.length) s += ` ${locked.length === 1 ? "The locked circuit stays" : `The ${locked.length} locked circuits stay`} where ${locked.length === 1 ? "it is" : "they are"}.`;
    return s;
  }

  function viewReview(p, W) {
    const pr = W.pr;
    if (!pr) {
      return `<div class="card fix"><div class="card-h"><h2>Proposed fix</h2></div>
        <div class="empty-state"><p>Press <b>Find the fewest moves</b> and the copilot will search for the smallest change that brings ${p.name} within ${S.cfg.target}%. You check every change before anything is written to the model.</p></div></div>`;
    }
    let banner = "";
    if (pr.status === "ok" && pr.approach !== "lpt") banner = `<div class="banner banner-ok">${icon("check")}<p>Already within ${pr.target}%. No changes needed.</p></div>`;
    if (pr.status === "needs") banner = `<div class="banner banner-needs">${icon("alert")}<p><b>Needs an engineer.</b> ${esc(pr.reason)}</p></div>`;
    if (pr.status === "locked") banner = `<div class="banner banner-locked">${icon("lock")}<p><b>Blocked by locks.</b> ${esc(pr.reason)}</p></div>`;
    const warns = pr.warnings.map((w) => `<div class="banner banner-warn">${icon("alert")}<p>${esc(w)}</p></div>`).join("");
    const moves = pr.changes.map((c) => `<li>
      <span class="mv-no">${c.fromSlot}</span>
      <div><div class="mv-name">${esc(c.name)} <span>${fmt(c.va)} VA</span></div>
      <div class="mv-path">slot ${c.fromSlot} ${phtag(c.fromPhase)} ${icon("arrow")} slot ${c.toSlot} ${phtag(c.toPhase)} <span>· new number <b>${c.toSlot}</b>${c.kind === "swap" ? ` · swaps with ${c.partnerSlot}` : ""}</span></div></div>
    </li>`).join("");
    const spares = pr.spareMoves.length ? `<p class="hint" style="padding:0 16px 10px">A spare breaker shifts to make room: ${pr.spareMoves.map((m) => `slot ${m.fromSlot} → ${m.toSlot}`).join(", ")}.</p>` : "";
    const t = S.tx.find((x) => x.panelId === p.id && !x.undone);
    let buttons;
    if (p.review === "applied") buttons = `<span class="chip chip-applied">${icon("check")}Applied</span>${t ? `<button class="btn" data-act="undo" data-id="${t.id}">${icon("undo")} Undo</button>` : ""}`;
    else if (p.review === "rejected") buttons = `<span class="chip chip-rejected">${icon("x")}Rejected</span><button class="btn" data-act="unreview" data-id="${p.id}">Reconsider</button>`;
    else if (pr.changes.length) buttons = `<button class="btn btn-primary" id="btn-apply" data-act="apply" data-id="${p.id}">${icon("check")} ${pr.status === "proposed" ? "Apply fix" : "Apply best effort"}</button><button class="btn" data-act="reject" data-id="${p.id}">Reject</button>`;
    else buttons = "";
    return `<div class="review-grid">
      <div class="card fix">
        <div class="card-h"><h2>Proposed fix</h2><span class="card-sub">${pr.approach === "lpt" ? "Fresh layout" : "Fewest moves"} · ${pct(pr.beforeImb)} → ${pct(pr.afterImb)}</span></div>
        ${banner}
        ${moves ? `<ol class="moves">${moves}</ol>` : ""}
        ${spares}${warns}
        <p class="fix-explain">${esc(explain(p, pr))}</p>
        <div class="fix-foot">
          <div class="metrics"><span><b>${plural(pr.changes.length, "circuit")}</b> renumbered</span><span>Re-check ${pr.readBackOk ? `<b class="tx-fix">±1 VA ✓</b>` : `<b class="tx-alarm">failed</b>`}</span></div>
          ${buttons ? `<div class="actions">${buttons}</div>` : ""}
        </div>
      </div>
      ${viewTrace(p, pr)}
    </div>`;
  }

  // ---------------------------------------------------------------- compare view
  function viewCompare() {
    const p = panel(S.compare);
    const cur = live(p);
    const lpt = PM.propose(p, S.cfg, "lpt");
    const mm = PM.propose(p, S.cfg, "min_move");
    const t = S.cfg.target;
    const cols = [
      { key: "drawn", title: "As drawn", sub: "Today's layout", circuits: p.circuits, imb: cur.imb, changes: [], status: cur.imb > t ? "over" : "ok" },
      { key: "lpt", title: "Fresh layout", sub: "Re-sorts every circuit, largest first", circuits: lpt.newCircuits, imb: lpt.afterImb, changes: lpt.changes, status: lpt.afterImb <= t ? "ok" : "over", pr: lpt },
      { key: "mm", title: "Fewest moves", sub: "The copilot's default", circuits: mm.newCircuits, imb: mm.afterImb, changes: mm.changes, status: mm.afterImb <= t ? "ok" : mm.status === "locked" ? "locked" : "needs", pr: mm, best: true },
    ];
    let pitch;
    if (cur.imb <= t) pitch = `${p.name} is already within ${t}%. Fewest moves leaves it alone; a fresh layout would still renumber <em>${plural(lpt.changes.length, "circuit")}</em>.`;
    else if (lpt.afterImb <= t && mm.afterImb <= t) pitch = `Both fix it. Fewest moves renumbers <em>${plural(mm.changes.length, "circuit")}</em>; a fresh layout renumbers ${plural(lpt.changes.length, "circuit")}.`;
    else pitch = `Fewest moves reaches ${pct(mm.afterImb)} by renumbering ${plural(mm.changes.length, "circuit")}; a fresh layout reaches ${pct(lpt.afterImb)} with ${plural(lpt.changes.length, "circuit")}.`;
    const col = (c) => {
      const moved = new Map(c.changes.map((ch) => [ch.id, ch]));
      const occ = new Map(); for (const k of c.circuits) for (const s of PM.slotsOf(k)) occ.set(s, k);
      let cells = "";
      for (let s = 1; s <= p.ways; s++) {
        const k = occ.get(s), ph = PM.phaseOfSlot(s);
        if (!k || k.spare) { cells += `<div class="sm ph-${ph}">${s}<span class="va">${k ? "spare" : ""}</span></div>`; continue; }
        const mv = moved.get(k.id);
        cells += `<div class="sm load ph-${ph} ${mv ? "moved" : ""} ${PM.isLocked(k, S.cfg) ? "locked" : ""}" title="${esc(k.name)} · slot ${s}, phase ${ph}${mv ? ` · was slot ${mv.fromSlot}` : ""}"><b>${s}</b>${mv ? `<span>← ${mv.fromSlot}</span>` : ""}<span class="va">${fmt(PM.basisVA(k, S.cfg) / k.poles)}</span></div>`;
      }
      const issued = new Set(); for (const ch of c.changes) for (const sh of ch.sheets || []) if (sh.issued) issued.add(sh.id);
      return `<div class="card cmp-col ${c.best ? "best" : ""}">
        <div class="card-h"><h2>${c.title}</h2>${chip(c.status)}<span class="card-sub" style="flex-basis:100%">${c.sub}</span></div>
        <div class="cmp-stats">
          <div><span class="k">Out of balance</span><span class="v ${c.imb > t ? "tx-alarm" : "tx-fix"}">${pct(c.imb)}</span></div>
          <div><span class="k">Renumbered</span><span class="v">${c.key === "drawn" ? "–" : c.changes.length}</span></div>
        </div>
        <div class="slotmap" aria-label="Slot map">${cells}</div>
        <p class="cmp-foot">${c.key === "drawn" ? "Coloured by the phase each slot is on." : c.changes.length ? `Touches ${plural(issued.size, "issued drawing")}.` : "No circuits change."}</p>
      </div>`;
    };
    return `<section class="view" aria-labelledby="h-cmp">
      <div class="view-head">
        <div><p class="eyebrow">Why fewest moves</p><h1 id="h-cmp">Compare</h1><p class="cmp-pitch">${pitch}</p></div>
        <div class="actions" style="align-items:center">
          <label class="ctl-label" for="cmp-panel">Panel</label>
          <select id="cmp-panel">${S.panels.map((q) => `<option value="${q.id}" ${q.id === p.id ? "selected" : ""}>${q.name}</option>`).join("")}</select>
          <button class="btn btn-sm" data-act="cmp-worked">Worked example</button>
        </div>
      </div>
      <div class="cmp-grid">${cols.map(col).join("")}</div>
      <p class="hint">Every renumbered circuit means updating tags on plans and schedules. A fresh layout suits panels not yet issued; fewest moves suits panels already on issued drawings.</p>
    </section>`;
  }

  // ---------------------------------------------------------------- report view
  function kpis() {
    const n = S.panels.length;
    const audited = S.panels.filter((p) => p.audit).length;
    const within = S.panels.filter((p) => live(p).imb <= S.cfg.target).length;
    const flaggedWithReason = S.panels.filter((p) => p.proposal && p.review !== "applied" && ["needs", "locked"].includes(p.proposal.status)).length;
    const applied = S.tx.filter((t) => !t.undone);
    const avgMoves = applied.length ? applied.reduce((s, t) => s + t.changes, 0) / applied.length : null;
    const acted = S.panels.filter((p) => p.proposal && (p.review || ["needs", "locked"].includes(p.proposal.status)));
    const logged = acted.filter((p) => S.log.some((r) => r.panel === p.name)).length;
    return [
      { id: "O1", name: "Panels checked automatically", val: audited ? `${Math.round(audited / n * 100)}%` : "–", target: "100%", met: audited === n },
      { id: "O2", name: `Panels within ${S.cfg.target}% or flagged`, val: audited ? `${within}/${n}` : "–", target: "≥ 95%", met: audited && (within / n >= 0.95 || within + flaggedWithReason === n) },
      { id: "O3", name: "Circuits renumbered per fixed panel", val: avgMoves == null ? "–" : avgMoves.toFixed(1), target: "≤ 3", met: avgMoves != null && avgMoves <= 3 },
      { id: "O4", name: "Engineer minutes per panel", val: "Measured in pilot week 1", na: true, target: "≤ 3", met: null },
      { id: "O5", name: "Decisions logged with before/after", val: acted.length ? `${Math.round(logged / acted.length * 100)}%` : "–", target: "100%", met: acted.length && logged === acted.length },
    ];
  }

  const CSV_COLS = ["timestamp", "project", "panel", "basis", "LA_before", "LB_before", "LC_before", "imbalance_before_pct", "LA_after", "LB_after", "LC_after", "imbalance_after_pct", "circuits_moved", "changes", "status", "engineer", "approach"];
  function csvText() {
    const q = (v) => { const s = String(v == null ? "" : v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    return [CSV_COLS.join(","), ...S.log.map((r) => CSV_COLS.map((c) => q(r[c])).join(","))].join("\n");
  }

  function viewReport() {
    const K = kpis();
    const tiles = K.map((k) => `<div class="card kpi">
      <span class="kid">${k.id}</span><span class="kname">${k.name}</span>
      <span class="kval ${k.na ? "na" : ""}">${k.val}</span>
      <span class="ktarget">Target ${k.target}</span>
      ${k.met === null ? "" : k.met ? `<span class="chip chip-ok">${icon("check")}Met</span>` : `<span class="chip chip-unknown">${icon("dot")}Not yet</span>`}
    </div>`).join("");
    const statusChip = { Applied: "applied", Rejected: "rejected", "Needs engineer": "needs", "Locked-limited": "locked", Undone: "rejected" };
    const logRows = S.log.slice().reverse().map((r) => `<li>
      <span class="plate">${r.panel}</span>
      <div class="lg-main"><span>${r.imbalance_before_pct}% → <b>${r.imbalance_after_pct}%</b> · ${plural(r.circuits_moved, "circuit")} moved</span>${r.changes ? `<span class="lg-sub">${esc(r.changes)}</span>` : ""}</div>
      <div class="actions" style="align-items:center"><span class="chip chip-${statusChip[r.status] || "rejected"}">${esc(r.status === "Locked-limited" ? "Blocked by locks" : r.status)}</span><time>${r.timestamp.slice(11)}</time></div>
    </li>`).join("");
    const txs = S.tx.map((t) => `<li class="${t.undone ? "undone" : ""}"><span class="tname">${esc(t.name)}</span><span class="hint">${plural(t.changes, "circuit")} · ${hms(t.at)}</span>
      ${t.undone ? `<span class="chip chip-rejected">Undone</span>` : `<button class="btn btn-sm" data-act="undo" data-id="${t.id}">${icon("undo")} Undo</button>`}</li>`).join("");
    const acts = S.activity.slice(0, 60).map((a) => `<li class="k-${a.kind}"><time>${hms(a.t)}</time><span>${esc(a.text)}</span></li>`).join("");
    return `<section class="view" aria-labelledby="h-rep">
      <div class="view-head"><div>
        <p class="eyebrow">Step 5 · Report</p><h1 id="h-rep">Report</h1>
        <p class="lede">How this session measures against the pilot targets, and a record of every decision.</p>
      </div></div>
      <div class="kpis">${tiles}</div>
      <div class="card"><div class="card-h"><h2>Decisions</h2><span class="card-sub">${S.log.length ? "Newest first" : ""}</span></div>
        ${logRows ? `<ul class="logc">${logRows}</ul>` : `<div class="empty-state"><p>Nothing logged yet. Every fix you apply or reject, and every panel flagged for an engineer, is recorded here.</p><button class="btn btn-sm" data-act="view" data-id="audit">Go to the audit</button></div>`}</div>
      ${txs ? `<div class="card"><div class="card-h"><h2>Model changes</h2><span class="card-sub">Each can be undone</span></div><ul class="tx-list">${txs}</ul></div>` : ""}
      <details class="card-more more" id="d-csv" ${openAttr("d-csv", false)}><summary>Export as CSV <span class="sum-val">${plural(S.log.length, "row")}</span></summary>
        <pre class="csv" id="csv-pre" tabindex="0">${esc(csvText())}</pre>
        <div class="csv-actions">
          ${S.dl === "local" || S.dl === "ok" ? `<button class="btn btn-sm" data-act="csv-download" ${S.log.length ? "" : "disabled"}>${icon("download")} Download CSV</button>` : ""}
          <button class="btn btn-sm" data-act="csv-copy" ${S.log.length ? "" : "disabled"}>${icon("copy")} Copy CSV</button>
        </div>
      </details>
      <details class="card-more more" id="d-activity" ${openAttr("d-activity", false)}><summary>Activity log <span class="sum-val">${plural(S.activity.length, "event")}</span></summary>
        ${acts ? `<ol class="activity">${acts}</ol>` : `<div class="empty-state"><p>Nothing has run yet.</p></div>`}
      </details>
    </section>`;
  }

  // ---------------------------------------------------------------- settings view
  const RULES = [
    ["R1", "Only single-pole, unlocked circuits can move", "Hard", "Two- and three-pole circuits and locked circuits count as fixed load."],
    ["R2", "Multi-pole circuits stay put; their load splits evenly across their phases", "Hard", "See PP-1A and PP-R1."],
    ["R3", "Locked slots and DoNotMove circuits never move", "Hard", "Tap any padlock on the panelboard; an open fix re-runs around it."],
    ["R4", "A phase can't take more single-pole circuits than it has free slots", "Hard", "RP-2B has no free C slots, so it can only swap onto C."],
    ["R5", "Imbalance must end at or below the target", "Goal", "Target slider from 5 to 15%. The search stops once it is met."],
    ["R6", "Renumber as few circuits as possible", "Objective", "Options are scored by balance gained per circuit renumbered."],
    ["R7", "Spares and spaces can take a moved circuit", "Hard", "A displaced spare takes the freed slot. See PP-1A."],
    ["R8", "Keep circuits of one group together", "Later", "Planned for v2; not simulated."],
    ["R9", "Balance on connected or demand load", "Setting", "Load basis option. Demand factors below are placeholders."],
  ];
  const ASSUME = [
    "Panels follow the standard A-B-C row sequence. Check for non-standard panel families.",
    "The balance basis is connected VA, or demand VA if the project standard says so.",
    "The firm threshold is 10% unless a project specifies otherwise.",
    "pyRevit is permitted on production machines. If not, plan for the C# add-in route.",
    "How Revit's built-in Rebalance Loads treats locked slots in the firm's Revit version.",
    "Renumbering after issue is acceptable when it goes through a revision cloud and is logged.",
  ];

  function configJson() {
    const c = S.cfg;
    const obj = { imbalance_target_pct: c.target, balance_basis: c.basis, default_approach: c.approach, max_moves_per_panel: c.maxMoves, respect_locked_slots: c.respectLocks, do_not_move_parameter: c.doNotMoveParam, log_path: "./phase_balancer_log.csv", system_voltage: c.voltage, demand_factors: c.demandFactors };
    return esc(JSON.stringify(obj, null, 2)).replace(/(&quot;[a-z_]+&quot;):/gi, '<span class="k1">$1</span>:').replace(/: (&quot;[^&]*&quot;|[\d.]+|true|false)/g, ': <span class="v1">$1</span>');
  }

  function viewRules() {
    const c = S.cfg;
    const checked = store.get("pbc-assumptions") || {};
    const tests = S.tests;
    return `<section class="view" aria-labelledby="h-rules">
      <div class="view-head">
        <div><p class="eyebrow">Firm rules</p><h1 id="h-rules">Settings</h1><p class="lede">Change a setting and every open fix re-runs with it.</p></div>
        <div class="actions"><button class="btn btn-sm" data-act="reset">${icon("reset")} Reset sample model</button></div>
      </div>
      <div class="cfg-grid">
        <div class="card"><div class="card-h"><h2>Main settings</h2></div>
          <div class="form">
            <label for="cfg-target">Target imbalance (%)</label><input type="number" id="cfg-target" min="1" max="30" step="1" value="${c.target}">
            <label for="cfg-approach">Method</label><select id="cfg-approach"><option value="min_move" ${c.approach === "min_move" ? "selected" : ""}>Fewest moves</option><option value="lpt" ${c.approach === "lpt" ? "selected" : ""}>Fresh layout</option></select>
            <label for="cfg-basis">Load basis</label><select id="cfg-basis"><option value="connected" ${c.basis === "connected" ? "selected" : ""}>Connected load</option><option value="demand" ${c.basis === "demand" ? "selected" : ""}>Demand load</option></select>
            <label for="cfg-respect">Respect locked slots</label><span><input type="checkbox" id="cfg-respect" ${c.respectLocks ? "checked" : ""}></span>
          </div>
          <details class="more" id="d-moreset" ${openAttr("d-moreset", false)}><summary>More settings</summary>
            <div class="form">
              <label for="cfg-maxmoves">Max moves per panel</label><input type="number" id="cfg-maxmoves" min="1" max="20" step="1" value="${c.maxMoves}">
              <label for="cfg-voltage">System voltage</label><select id="cfg-voltage">${Object.entries(PM.VOLTAGES).map(([k, v]) => `<option value="${k}" ${c.voltage === k ? "selected" : ""}>${v.label}</option>`).join("")}</select>
              <label for="cfg-engineer">Engineer name for the log</label><input type="text" id="cfg-engineer" value="${esc(c.engineer)}">
              ${Object.keys(c.demandFactors).map((k) => `<label for="df-${k}">Demand factor · ${CLS[k]}</label><input type="number" id="df-${k}" min="0" max="1" step="0.05" value="${c.demandFactors[k]}">`).join("")}
            </div>
          </details>
          <details class="more" id="d-json" ${openAttr("d-json", false)}><summary>config.json</summary><pre class="json" aria-label="config.json">${configJson()}</pre></details>
        </div>
        <div class="card"><div class="card-h"><h2>Core self-test</h2><button class="btn btn-sm" data-act="run-tests">${icon("check")} Run tests</button></div>
          ${tests ? `<ul class="tests">${tests.map((t) => `<li><span class="${t.pass ? "pass" : "fail"}">${icon(t.pass ? "check" : "x")}</span><span class="tid">${t.id}</span><span>${esc(t.name)}<span class="detail">${esc(t.detail)}</span></span></li>`).join("")}</ul>`
          : `<div class="empty-state"><p>Runs the nine unit tests from the concept note against the same core this page uses.</p></div>`}
        </div>
      </div>
      <details class="card-more more" id="d-rules" ${openAttr("d-rules", false)}><summary>Engineering rules <span class="sum-val">R1–R9</span></summary>
        <ul class="rules-list">${RULES.map((r) => `<li><span class="rid">${r[0]}</span><span>${r[1]}<span class="how">${r[3]}</span></span><span class="type ${r[2] === "Hard" ? "hard" : ""}">${r[2]}</span></li>`).join("")}</ul>
      </details>
      <details class="card-more more" id="d-assume" ${openAttr("d-assume", false)}><summary>Questions for the technical directors <span class="sum-val">${ASSUME.filter((a, i) => checked[i]).length}/${ASSUME.length} agreed</span></summary>
        <ul class="assume">${ASSUME.map((a, i) => `<li><label><input type="checkbox" id="as-${i}" ${checked[i] ? "checked" : ""}><span>${a}</span></label></li>`).join("")}</ul>
      </details>
    </section>`;
  }

  function runSelfTests() {
    const C = PB.Circuit, P = PHASES, r1 = (x) => Math.round(x * 10) / 10;
    const worked = () => [2400, 1800, 1500, 1500, 1200, 1000, 900, 800, 600].map((v, i) => C(2 * i + 1, v, [P[i % 3]]));
    const T = [];
    const add = (id, name, fn) => { try { const [pass, detail] = fn(); T.push({ id, name, pass, detail }); } catch (e) { T.push({ id, name, pass: false, detail: String(e) }); } };
    add("T1", "Worked example, fewest moves, target 5%", () => { const [r, m] = PB.minMoveBalance(worked(), { target_pct: 5 }); const i = r1(PB.imbalancePct(PB.phaseLoads(r))); return [i === 2.6 && m.size === 1 && m.has(13), `imbalance ${i}%, moved {${[...m]}}`]; });
    add("T2", "Worked example, fresh layout", () => { const d = worked(), r = PB.lptBalance(d); const mv = r.filter((c, k) => c.phases[0] !== d[k].phases[0]).map((c) => c.number); const i = r1(PB.imbalancePct(PB.phaseLoads(r))); return [i === 2.6 && mv.join() === "7,11,13,15,17", `imbalance ${i}%, moved [${mv}]`]; });
    add("T3", "Already balanced panel", () => { const [, m] = PB.minMoveBalance([C(1, 1000, ["A"]), C(2, 1000, ["B"]), C(3, 1050, ["C"])], { target_pct: 10 }); return [m.size === 0, `${m.size} moves`]; });
    add("T4", "All circuits locked", () => { const p = { ways: 6, circuits: [1, 3, 5].map((s, k) => ({ id: "t" + s, slot: s, poles: 1, va: [3000, 500, 500][k], cls: "REC", doNotMove: true })) }; const a = PM.audit(p, S.cfg); return [a.status === "locked", `status ${a.status}`]; });
    add("T5", "Only 3-pole circuits", () => { const cs = [C(1, 9000, P), C(7, 4500, P)]; const i = PB.imbalancePct(PB.phaseLoads(cs)); const [, m] = PB.minMoveBalance(cs, { target_pct: 5 }); return [i === 0 && m.size === 0, `imbalance ${i}%, ${m.size} moves`]; });
    add("T6", "One huge single-pole load", () => { const p = { ways: 12, circuits: [[1, 9000], [3, 1000], [5, 1000], [7, 1000]].map(([s, v]) => ({ id: "h" + s, slot: s, poles: 1, va: v, cls: "EQP" })) }; const r = PM.propose(p, S.cfg, "min_move"); return [!r.reached && r.status === "needs", `${r.status}, best ${pct(r.afterImb)}`]; });
    add("T7", "Phase C has no free slots", () => { const tr = []; const cs = [C(1, 3000, ["A"]), C(7, 2000, ["A"]), C(3, 1500, ["B"]), C(5, 1000, ["C"]), C(11, 900, ["C"]), C(17, 800, ["C"])]; const [r] = PB.minMoveBalance(cs, { target_pct: 5, slot_capacity: { A: 6, B: 6, C: 3 }, trace: tr }); const bad = tr.some((t) => t.step && t.step.kind === "move" && t.step.to[0] === "C"); const onC = r.filter((c) => c.phases[0] === "C").length; return [!bad && onC <= 3, `no single move onto C; ${onC} circuits on C`]; });
    add("T8", "Empty panel or zero load", () => { const i = PB.imbalancePct(PB.phaseLoads([])); const [, m] = PB.minMoveBalance([C(1, 0, ["A"])], { target_pct: 5 }); return [i === 0 && m.size === 0, `imbalance ${i}%, no crash`]; });
    add("T9", "2-pole load splits 50/50 and never moves", () => { const cs = [C(1, 4000, ["A", "B"]), C(5, 3000, ["C"]), C(7, 2500, ["A"]), C(9, 200, ["B"])]; const L = PB.phaseLoads([cs[0]]); const [r] = PB.minMoveBalance(cs, { target_pct: 5 }); const kept = r.find((c) => c.number === 1).phases.join(""); return [L.A === 2000 && L.B === 2000 && kept === "AB", `A ${L.A} / B ${L.B}, stays on ${kept}`]; });
    return T;
  }

  // ---------------------------------------------------------------- guided dry run
  const LP = "LP-2A";
  const SCENES = [
    { title: "The pilot model", step: 1,
      run() { S.view = "audit"; },
      caption: () => "Twelve panels across five floors of a sample building. Circuits were placed by hand and loads have changed since. Nobody has checked the balance yet." },
    { title: "Check every panel", step: 1,
      run(fast) { runAudit(!fast); S.view = "audit"; },
      caption: () => { const s = auditSummary(); return `One click checks every panel: ${s.n} checked, ${s.over} over the ${S.cfg.target}% target. The worst is ${s.worst.name} at ${pct(s.worst.audit.imb)}. Nothing in the model has changed.`; } },
    { title: "Open LP-2A", step: 1,
      run() { S.sel = LP; S.view = "workspace"; S.boardMode = "drawn"; S.boardStyle = "board"; S.selCircuit = null; },
      caption: () => { const a = live(panel(LP)); return `LP-2A is the worked example. Phase A carries ${fmt(a.loads.A)} VA against an average of ${fmt(a.total / 3)} VA, so it is ${pct(a.imb)} out of balance. A breaker's row decides its phase, so fixing it means moving breakers.`; } },
    { title: "Search for the fewest moves", step: 2,
      run(fast) { const p = panel(LP); S.sel = LP; S.view = "workspace"; S.boardMode = "drawn"; propose(p, "min_move"); S.open["d-trace"] = true; if (!fast) { S.anim.trace = true; S.anim.eval = true; } },
      caption: () => { const t = panel(LP).proposal.trace[0]; return `The copilot tries all ${t.evaluatedMoves} single moves and ${t.evaluatedSwaps} swaps, and scores each by balance gained per circuit renumbered. One move is enough, so it stops.`; } },
    { title: "The fix", step: 3,
      run(fast) { S.sel = LP; S.view = "workspace"; if (fast) { S.boardMode = "proposed"; return null; } S.boardMode = "drawn"; return () => setTimeout(() => switchBoard("proposed"), 700); },
      caption: () => { const pr = panel(LP).proposal, c = pr.changes[0]; return `Move “${c.name}” (${fmt(c.va)} VA) from slot ${c.fromSlot} on phase ${c.fromPhase} to slot ${c.toSlot} on phase ${c.toPhase}. Imbalance drops from ${pct(pr.beforeImb)} to ${pct(pr.afterImb)}. Only one circuit gets a new number.`; } },
    { title: "Against a naive rebalance", step: 3,
      run() { S.view = "compare"; S.compare = LP; },
      caption: () => { const p = panel(LP); const l = PM.propose(p, S.cfg, "lpt"), m = PM.propose(p, S.cfg, "min_move"); const iss = new Set(); l.changes.forEach((c) => c.sheets.forEach((s) => s.issued && iss.add(s.id))); return `A fresh layout also reaches ${pct(l.afterImb)}, but renumbers ${plural(l.changes.length, "circuit")} and touches ${plural(iss.size, "issued drawing")}. Fewest moves needs just ${m.changes.length}.`; } },
    { title: "Respect the engineer's locks", step: 3,
      run(fast) {
        const p = panel(LP); S.sel = LP; S.view = "workspace";
        const c = p.circuits.find((x) => x.name === "Receptacles – Bay 3");
        c.doNotMove = true; modelChanged(p); propose(p, "min_move");
        activity(`${p.name}: circuit ${c.slot} "${c.name}" locked (DoNotMove)`);
        if (fast) { S.boardMode = "proposed"; return null; }
        S.boardMode = "drawn"; return () => setTimeout(() => switchBoard("proposed"), 900);
      },
      caption: () => { const pr = panel(LP).proposal; return `Lock “Receptacles – Bay 3” and the copilot works around it: it swaps “${pr.changes[0].name}” and “${pr.changes[1].name}” instead, and still reaches ${pct(pr.afterImb)}.`; } },
    { title: "Fix every flagged panel", step: 3,
      run() {
        const p = panel(LP); const c = p.circuits.find((x) => x.name === "Receptacles – Bay 3"); c.doNotMove = false; modelChanged(p);
        activity(`${p.name}: circuit ${c.slot} unlocked`);
        balanceAllFlagged(); S.view = "audit";
      },
      caption: () => { const ps = S.panels.filter((p) => p.proposal); const ok = ps.filter((p) => p.proposal.status === "proposed"); const other = ps.filter((p) => ["needs", "locked"].includes(p.proposal.status)); return `The copilot proposes fixes for all ${ps.length} flagged panels. ${ok.length} reach ${S.cfg.target}%. ${other.map((p) => p.proposal.status === "locked" ? `${p.name} is blocked by its locks` : `${p.name} needs an engineer`).join(" and ")}${other.length ? ", each with a reason." : ""}`; } },
    { title: "Engineer review", step: 4,
      run() { pendingPanels().forEach((p) => review(p, "accepted")); S.view = "audit"; },
      caption: () => `The engineer accepts or rejects each fix. Here all ${acceptedPanels().length} are accepted. The model is still untouched.` },
    { title: "Apply and re-check", step: 5,
      run() { applyAccepted(); S.view = "audit"; },
      caption: () => { const t = S.tx.filter((x) => !x.undone); return `Accepted fixes are written to the model as undoable changes: ${plural(t.reduce((s, x) => s + x.changes, 0), "circuit")} across ${plural(t.length, "panel")}. Each panel's loads are re-checked to within ±1 VA.`; } },
    { title: "Report", step: 5,
      run() { S.view = "report"; },
      caption: () => { const within = S.panels.filter((p) => live(p).imb <= S.cfg.target).length; return `Every decision is logged for QA. ${within} of ${S.panels.length} panels are now within ${S.cfg.target}%; the other ${S.panels.length - within} carry a reason for the engineer.`; } },
  ];

  function goScene(i) {
    i = Math.max(0, Math.min(SCENES.length - 1, i));
    clearTimeout(S.tour.timer);
    S.tour.on = true; S.tour.i = i;
    resetProject(); S.cfg = clone(PM.DEFAULT_CONFIG); S.open = {}; S.opts = false;
    for (let k = 0; k < i; k++) SCENES[k].run(true);
    S.anim = {};
    const post = SCENES[i].run(false);
    render();
    window.scrollTo(0, 0);
    // On a phone the presenter strip covers the lower screen, so bring the board into view for board scenes.
    if (window.innerWidth <= 720 && S.view === "workspace" && [3, 4, 6].includes(i)) { const b = $(".board-frame"); if (b) b.scrollIntoView({ block: "start" }); }
    if (typeof post === "function") post();
    scheduleAuto();
  }
  function scheduleAuto() {
    clearTimeout(S.tour.timer);
    if (S.tour.on && S.tour.auto && S.tour.i < SCENES.length - 1) S.tour.timer = setTimeout(() => goScene(S.tour.i + 1), 10000);
    else if (S.tour.auto && S.tour.i >= SCENES.length - 1) S.tour.auto = false;
  }
  function endTour() { clearTimeout(S.tour.timer); S.tour.on = false; S.tour.auto = false; render(); }

  function viewPresenter() {
    const sc = SCENES[S.tour.i];
    let cap = "";
    try { cap = sc.caption(); } catch (e) { cap = ""; }
    return `<div class="pz">
      <div class="pz-progress">${SCENES.map((s, k) => `<button class="${k < S.tour.i ? "done" : k === S.tour.i ? "now" : ""}" data-act="scene" data-id="${k}" aria-label="Scene ${k + 1}: ${esc(s.title)}"></button>`).join("")}</div>
      <div>
        <div class="pz-step">${S.tour.i + 1} of ${SCENES.length} · ${STEPS[sc.step - 1]}</div>
        <h3 class="pz-title">${esc(sc.title)}</h3>
        <p class="pz-caption">${esc(cap)}</p>
      </div>
      <div class="pz-ctl">
        <button class="btn" data-act="scene-prev" ${S.tour.i === 0 ? "disabled" : ""} aria-label="Back">${icon("prev")} Back</button>
        <button class="btn btn-primary" id="pz-next" data-act="scene-next" ${S.tour.i === SCENES.length - 1 ? "disabled" : ""}>Next ${icon("next")}</button>
        <button class="btn" data-act="scene-auto" aria-pressed="${S.tour.auto}" aria-label="${S.tour.auto ? "Pause" : "Auto-play"}">${icon(S.tour.auto ? "pause" : "play")}<span class="hide-m">${S.tour.auto ? "Pause" : "Auto-play"}</span></button>
        <button class="btn" data-act="tour-end">Exit</button>
      </div>
    </div>`;
  }

  // ---------------------------------------------------------------- animation
  function switchBoard(mode) {
    const before = new Map($$(".board [data-cid]").map((el) => [el.dataset.cid, el.getBoundingClientRect()]));
    S.boardMode = mode;
    render();
    if (reduced() || !Element.prototype.animate) return;
    $$(".board [data-cid]").forEach((el) => {
      const b = before.get(el.dataset.cid);
      if (!b) return;
      const a = el.getBoundingClientRect();
      const dx = b.left - a.left, dy = b.top - a.top;
      if (Math.abs(dx) + Math.abs(dy) < 1) return;
      el.classList.add("flying");
      const anim = el.animate([
        { transform: `translate(${dx}px, ${dy}px)` },
        { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 26}px) scale(1.04)`, offset: 0.5 },
        { transform: "translate(0, 0)" },
      ], { duration: 1150, easing: "cubic-bezier(.35, 0, .2, 1)" });
      anim.onfinish = () => el.classList.remove("flying");
    });
  }

  function tween(from, to, ms, step) {
    if (reduced() || from === to) { step(to); return; }
    const t0 = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const tick = (t) => { const k = Math.min(1, (t - t0) / ms); step(from + (to - from) * ease(k)); if (k < 1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }

  function afterRender() {
    if (S.view !== "workspace") return;
    const memo = vizMemo(panel(S.sel));
    const bars = $$(".pl-bar[data-w]");
    if (bars.length) { void bars[0].offsetWidth; requestAnimationFrame(() => bars.forEach((b) => { b.style.width = b.dataset.w; })); }
    memo.bars = memo.barsNext;
    const big = $(".imb-big[data-tween-to]");
    if (big) {
      const from = parseFloat(big.dataset.tweenFrom), to = parseFloat(big.dataset.tweenTo);
      memo.imb = to;
      tween(from, to, 900, (v) => { big.textContent = pct(v); });
    }
    const svg = $("#phasor");
    if (svg) {
      const to = { a: +svg.dataset.a, b: +svg.dataset.b, c: +svg.dataset.c };
      const max = +svg.dataset.max || 1;
      const from = memo.phasor || to;
      memo.phasor = to;
      tween(0, 1, 900, (k) => drawPhasor(svg, { a: from.a + (to.a - from.a) * k, b: from.b + (to.b - from.b) * k, c: from.c + (to.c - from.c) * k }, max));
    }
  }

  // ---------------------------------------------------------------- misc UI
  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 3600);
  }
  function setTheme() {
    const root = document.documentElement;
    const cur = root.getAttribute("data-theme") || (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    store.set("pbc-theme", next);
  }
  function openPanel(id) {
    if (S.sel !== id) { S.selCircuit = null; S.boardMode = "drawn"; }
    S.sel = id; S.view = "workspace";
  }
  function runCopilot(p) {
    const pr = propose(p, S.cfg.approach, { log: true });
    S.anim.trace = true;
    if (pr.changes.length && p.review !== "applied") {
      S.boardMode = "drawn"; render();
      setTimeout(() => switchBoard("proposed"), reduced() ? 0 : 450);
    } else render();
  }
  const toTop = () => window.scrollTo({ top: 0, behavior: reduced() ? "auto" : "smooth" });

  // ---------------------------------------------------------------- events
  const ACTIONS = {
    "view": (id) => { S.view = id; render(); toTop(); $("#main").focus({ preventScroll: true }); },
    "open-panel": (id) => { openPanel(id); render(); toTop(); },
    "run-audit": () => { runAudit(true); S.view = "audit"; render(); },
    "balance-all": () => { const f = balanceAllFlagged(); render(); toast(`Fixes searched for ${plural(f.length, "panel")}. Review them in the list.`); },
    "accept-all": () => { const n = pendingPanels().length; pendingPanels().forEach((p) => review(p, "accepted")); render(); toast(`${plural(n, "fix", "fixes")} accepted. Apply when ready.`); },
    "apply-accepted": () => { const n = applyAccepted(); render(); toast(`${plural(n, "fix", "fixes")} applied. Each can be undone from the report.`); },
    "accept": (id) => { review(panel(id), "accepted"); render(); },
    "reject": (id) => { review(panel(id), "rejected"); render(); },
    "unreview": (id) => { panel(id).review = null; render(); },
    "apply": (id) => { const p = panel(id); if (apply(p)) { S.boardMode = "drawn"; render(); toast(`Fix applied to ${p.name}.`); } else render(); },
    "undo": (id) => { undo(id); S.boardMode = "drawn"; render(); toast("Change undone. The original layout is back."); },
    "sort": (key) => { S.sort = { key, dir: S.sort.key === key ? -S.sort.dir : key === "name" || key === "level" ? 1 : -1 }; S.open["d-table"] = true; render(); },
    "approach": (id) => { S.cfg.approach = id; const p = panel(S.sel); if (p.proposal && p.review !== "applied") runCopilot(p); else render(); },
    "basis": (id) => { S.cfg.basis = id; configChanged(); render(); },
    "toggle-opts": () => { S.opts = !S.opts; render(); },
    "run-copilot": () => runCopilot(panel(S.sel)),
    "design-change": () => { const r = simulateDesignChange(panel(S.sel)); render(); if (r) toast(`${r.ch.kind}: circuit ${r.c.slot} is now ${fmt(r.c.va)} VA. Re-run the audit to see it flagged.`); },
    "board-mode": (id) => { if (id !== S.boardMode) switchBoard(id); },
    "board-style": (id) => { S.boardStyle = id; render(); },
    "pick-circuit": (id) => { S.selCircuit = S.selCircuit === id ? null : id; render(); },
    "close-insp": () => { S.selCircuit = null; render(); },
    "toggle-lock": (id) => { const p = panel(S.sel); const re = toggleLock(p, id); if (re && p.proposal.changes.length) { S.anim.trace = true; S.boardMode = "drawn"; render(); setTimeout(() => switchBoard("proposed"), reduced() ? 0 : 450); } else render(); },
    "cmp-worked": () => { S.compare = LP; render(); },
    "csv-download": () => {
      const filename = `phase_balancer_log_${isoMin(new Date()).slice(0, 10)}.csv`;
      if (S.dl === "ok" && S.dlNs) {
        S.dlNs.save({ filename, data: csvText() }).then(
          (r) => toast(r && r.status === "delivered" ? "CSV handed over." : "CSV saved."),
          (e) => toast(e && e.code === "declined" ? "Download cancelled." : e && e.code === "rate_limited" ? "A save prompt is already open." : "This viewer could not save the file. Use Copy CSV instead."));
        return;
      }
      const blob = new Blob([csvText()], { type: "text/csv" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast("Download started.");
    },
    "csv-copy": () => {
      const text = csvText();
      const fallback = () => { const pre = $("#csv-pre"); if (pre) { const r = document.createRange(); r.selectNodeContents(pre); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); } toast("Copying is blocked here. The CSV text is selected, so copy it from there."); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast(`CSV copied: ${plural(S.log.length, "row")}.`), fallback);
      else fallback();
    },
    "run-tests": () => { S.tests = runSelfTests(); render(); const f = S.tests.filter((t) => !t.pass).length; toast(f ? `${f} of 9 tests failed.` : "All 9 tests pass."); },
    "reset": () => { resetProject(); S.view = "audit"; S.tour.on = false; render(); toTop(); toast("Sample model restored to its drawn state."); },
    "theme": () => setTheme(),
    "help": () => { S.intro = true; store.set("pbc-intro-hidden", false); S.view = "audit"; render(); toTop(); },
    "intro-hide": () => { S.intro = false; store.set("pbc-intro-hidden", true); render(); },
    "tour-start": () => { S.tour.auto = false; goScene(0); },
    "tour-end": () => endTour(),
    "scene": (id) => goScene(+id),
    "scene-next": () => goScene(S.tour.i + 1),
    "scene-prev": () => goScene(S.tour.i - 1),
    "scene-auto": () => { S.tour.auto = !S.tour.auto; render(); scheduleAuto(); },
  };

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || el.disabled) return;
    const fn = ACTIONS[el.dataset.act];
    if (!fn) return;
    e.preventDefault();
    fn(el.dataset.id);
  });
  document.addEventListener("toggle", (e) => { const d = e.target; if (d && d.tagName === "DETAILS" && d.id) S.open[d.id] = d.open; }, true);
  document.addEventListener("keydown", (e) => {
    const el = e.target;
    if ((e.key === "Enter" || e.key === " ") && el.getAttribute && el.getAttribute("role") === "button" && el.dataset.act) { e.preventDefault(); el.click(); return; }
    if (!S.tour.on || /INPUT|SELECT|TEXTAREA/.test(el.tagName)) return;
    if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); goScene(S.tour.i + 1); }
    else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); goScene(S.tour.i - 1); }
    else if (e.key === "Escape") endTour();
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "target") { const o = $("#target-out"); if (o) o.textContent = `${e.target.value}%`; }
  });
  document.addEventListener("change", (e) => {
    const el = e.target, id = el.id;
    const p = panel(S.sel);
    if (id === "target" || id === "cfg-target") { S.cfg.target = Math.max(1, Math.min(30, +el.value || 10)); configChanged(); render(); return; }
    if (id === "cfg-basis") { S.cfg.basis = el.value; configChanged(); render(); return; }
    if (id === "cfg-approach") { S.cfg.approach = el.value; render(); return; }
    if (id === "cfg-maxmoves") { S.cfg.maxMoves = Math.max(1, +el.value || 6); configChanged(); render(); return; }
    if (id === "cfg-respect") { S.cfg.respectLocks = el.checked; configChanged(); render(); return; }
    if (id === "cfg-voltage") { S.cfg.voltage = el.value; render(); return; }
    if (id === "cfg-engineer") { S.cfg.engineer = el.value.trim() || "Pilot engineer"; render(); return; }
    if (id.startsWith("df-")) { S.cfg.demandFactors[id.slice(3)] = Math.max(0, Math.min(1, +el.value)); configChanged(); render(); return; }
    if (id === "cmp-panel") { S.compare = el.value; render(); return; }
    if (id === "panel-pick") { openPanel(el.value); render(); return; }
    if (id.startsWith("as-")) { const st = store.get("pbc-assumptions") || {}; st[id.slice(3)] = el.checked; store.set("pbc-assumptions", st); render(); return; }
    if (id === "insp-va" || id === "insp-dnm" || id === "insp-ls") {
      const c = p.circuits.find((x) => x.id === S.selCircuit); if (!c) return;
      const had = p.proposal && p.review !== "applied" ? p.proposal.approach : null;
      if (id === "insp-va") { const old = c.va; c.va = Math.max(0, Math.round(+el.value || 0)); activity(`${p.name}: circuit ${c.slot} load edited ${fmt(old)} → ${fmt(c.va)} VA`, "warn"); }
      if (id === "insp-dnm") c.doNotMove = el.checked;
      if (id === "insp-ls") c.lockedSlot = el.checked;
      modelChanged(p);
      if (had) propose(p, had);
      render();
    }
  });

  const VIEWS = { audit: viewAudit, workspace: viewWorkspace, compare: viewCompare, report: viewReport, rules: viewRules };

  // ---------------------------------------------------------------- boot
  const savedTheme = store.get("pbc-theme");
  if (savedTheme === "dark" || savedTheme === "light") document.documentElement.setAttribute("data-theme", savedTheme);
  resetProject();
  const hp = new URLSearchParams((location.hash || "").replace(/^#/, ""));
  if (hp.get("theme")) document.documentElement.setAttribute("data-theme", hp.get("theme"));
  if (hp.get("intro") === "off") S.intro = false;
  if (hp.get("scene")) {
    goScene((+hp.get("scene") || 1) - 1);
    if (hp.get("presenter") === "off") S.tour.on = false;
  }
  if (hp.get("panel")) S.sel = hp.get("panel");
  if (hp.get("view")) S.view = hp.get("view");
  if (hp.get("mode")) S.boardMode = hp.get("mode");
  if (hp.get("style")) S.boardStyle = hp.get("style");
  if (hp.get("open")) hp.get("open").split(",").forEach((k) => { S.open[k] = true; });
  if (hp.get("opts")) S.opts = true;
  if (hp.get("tests")) S.tests = runSelfTests();
  render();
  if (S.dl === "pending") {
    window.claude.use("downloads").then((d) => { S.dlNs = d; S.dl = d ? "ok" : "none"; if (S.view === "report") render(); }, () => { S.dl = "none"; if (S.view === "report") render(); });
  }
  window.__pbc = { S, render, goScene };
})();
