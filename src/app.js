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
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };
  const CLS = { LTG: "Lighting", REC: "Receptacles", EQP: "Equipment", MECH: "Mechanical" };
  const STATUS = {
    unknown: { label: () => "Not audited", icon: "dot" },
    ok: { label: () => `Within ${S.cfg.target}%`, icon: "check" },
    over: { label: () => `Over ${S.cfg.target}%`, icon: "alert" },
    proposed: { label: () => "Proposal ready", icon: "bolt" },
    accepted: { label: () => "Accepted", icon: "check" },
    applied: { label: () => "Applied", icon: "check" },
    rejected: { label: () => "Rejected", icon: "x" },
    needs: { label: () => "Needs engineer", icon: "alert" },
    locked: { label: () => "Locked-limited", icon: "lock" },
  };
  const chip = (st) => `<span class="chip chip-${st}">${icon(STATUS[st].icon)}${STATUS[st].label()}</span>`;
  const FFL = { "Roof": "+17.60", "Level 04": "+13.20", "Level 03": "+8.80", "Level 02": "+4.40", "Level 01": "±0.00" };
  const STEPS = ["Audit", "Optimise", "Propose", "Review", "Apply & report"];

  // ---------------------------------------------------------------- state
  const S = {
    cfg: clone(PM.DEFAULT_CONFIG),
    panels: [], view: "audit", sel: "LP-2A", selCircuit: null,
    boardMode: "drawn", boardStyle: "board",
    log: [], activity: [], tx: [],
    compare: "LP-2A", sort: { key: "imb", dir: -1 },
    tour: { on: false, i: 0, auto: false, timer: null },
    anim: {}, designSeq: 0, viz: {}, tests: null,
    // CSV saving: "local" = plain browser download (opened as a file or self-hosted);
    // "pending"/"ok"/"none" = inside the claude.ai viewer, which offers files through its downloads capability.
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

  // keepBaseline: re-read after an apply keeps the imbalance found by the last audit run, so charts can show before and after.
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

  // ---------------------------------------------------------------- actions
  function runAudit(animate) {
    S.panels.forEach(snapshot);
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
      if (pr.status === "proposed") activity(`${p.name}: ${pr.approach === "lpt" ? "fresh layout" : "minimum-move"} proposal · ${plural(pr.changes.length, "circuit")} renumbered · ${pct(pr.beforeImb)} → ${pct(pr.afterImb)}`, "ok");
      else if (pr.status === "ok") activity(`${p.name}: within target at ${pct(pr.beforeImb)}. No changes proposed.`);
      else activity(`${p.name}: ${STATUS[pr.status].label()}. ${pr.reason}`, "warn");
    }
    if (o.log && (pr.status === "needs" || pr.status === "locked")) logEntry(p, pr, pr.status === "locked" ? "Locked-limited" : "Needs engineer");
    return pr;
  }

  function balanceAllFlagged() {
    const flagged = S.panels.filter((p) => p.review !== "applied" && ["over", "locked"].includes(auditStatus(p)));
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
    if (decision === "rejected") { logEntry(p, p.proposal, "Rejected"); activity(`${p.name}: proposal rejected by ${S.cfg.engineer}`, "warn"); }
    else activity(`${p.name}: proposal accepted, waiting to apply`, "ok");
  }

  function apply(p, group) {
    const pr = p.proposal;
    if (!pr || !pr.changes.length) return false;
    const prev = clone(p.circuits);
    p.circuits = clone(pr.newCircuits);
    const back = live(p).loads;
    if (!PHASES.every((ph) => Math.abs(back[ph] - pr.after[ph]) <= 1)) {
      p.circuits = prev;
      activity(`${p.name}: read-back did not match the prediction. Transaction rolled back.`, "alarm");
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
    const acc = S.panels.filter((p) => p.review === "accepted" && p.proposal);
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
    if (!c || c.spare || c.poles > 1) return;
    const had = p.proposal && p.review !== "applied" ? p.proposal.approach : null;
    if (c.lockedSlot && S.cfg.respectLocks) { c.lockedSlot = false; c.doNotMove = false; }
    else c.doNotMove = !c.doNotMove;
    const locked = PM.isLocked(c, S.cfg);
    activity(`${p.name}: circuit ${c.slot} "${c.name}" ${locked ? "flagged DoNotMove" : "unlocked"}`);
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

  function pipelineState() {
    if (S.tour.on) return { now: SCENES[S.tour.i].step, done: SCENES[S.tour.i].step - 1 };
    let done = 0;
    if (S.panels.some((p) => p.audit)) done = 1;
    if (S.panels.some((p) => p.proposal)) done = 3;
    const pend = S.panels.filter((p) => p.proposal && p.proposal.status === "proposed" && !p.review);
    if (done === 3 && !pend.length) done = 4;
    if (S.tx.some((t) => !t.undone)) done = 5;
    return { now: Math.min(done + 1, 5), done };
  }

  function viewTop() {
    const ps = pipelineState();
    const steps = STEPS.map((s, i) => {
      const n = i + 1;
      const cls = n <= ps.done ? "done" : n === ps.now ? "now" : "";
      return `<li class="${cls}">${i ? `<span class="wire ${n <= ps.done ? "done" : ""}" style="order:-1"></span>` : ""}${s}</li>`;
    }).join("");
    return `
      <div class="brand">
        <span class="plate plate-lg">Phase-Balancing Copilot</span>
        <div class="brand-meta">
          <span><b>${SP.project.number}</b> · ${esc(SP.project.name)}</span>
          <span class="dry">Dry run on sample data · no Revit connection</span>
        </div>
      </div>
      <ol class="pipeline" aria-label="Copilot pipeline">${steps}</ol>
      <div class="top-actions">
        ${S.tour.on ? "" : `<button class="btn btn-ink" data-act="tour-start">${icon("play")} Guided dry run</button>`}
        <button class="icon-btn" data-act="reset" title="Reset the sample model" aria-label="Reset the sample model">${icon("reset")}</button>
        <button class="icon-btn" data-act="theme" title="Switch light or dark" aria-label="Switch light or dark">${icon("theme")}</button>
      </div>`;
  }

  function viewTabs() {
    const acc = S.panels.filter((p) => p.review === "accepted").length;
    const tabs = [
      ["audit", "Project audit", ""],
      ["workspace", "Panel workspace", S.sel],
      ["compare", "Approach comparison", ""],
      ["report", "Report & log", S.log.length ? String(S.log.length) : ""],
      ["rules", "Rules & config", ""],
    ];
    return tabs.map(([id, label, count]) => `<button role="tab" id="tab-${id}" aria-selected="${S.view === id}" data-act="view" data-id="${id}">${label}${count ? `<span class="count">${esc(count)}</span>` : ""}${id === "audit" && acc ? `<span class="count">${acc} to apply</span>` : ""}</button>`).join("");
  }

  function miniBars(L, known) {
    const max = Math.max(L.A, L.B, L.C) || 1;
    return `<span class="mini ${known ? "" : "unknown"}" aria-hidden="true">${PHASES.map((ph) => `<i class="ph-${ph}" style="height:${(L[ph] / max * 100).toFixed(1)}%"></i>`).join("")}</span>`;
  }

  function viewBrowser() {
    const lv = SP.levels.map((level) => {
      const items = S.panels.filter((p) => p.level === level).map((p) => {
        const st = panelStatus(p);
        const a = live(p);
        return `<button class="pb-item" data-act="open-panel" data-id="${p.id}" aria-current="${S.view === "workspace" && S.sel === p.id}" title="${esc(p.use)} · ${STATUS[st].label()}">
          <span class="plate">${p.name}</span>
          ${miniBars(a.loads, !!p.audit)}
          <span class="pb-imb-wrap"><span class="pb-imb">${p.audit ? pct(a.imb) : "—"}</span><span class="lamp lamp-${st}"></span></span>
        </button>`;
      }).join("");
      return `<div class="pb-level"><div class="pb-level-name">${level}</div>${items}</div>`;
    }).join("");
    const acts = S.activity.slice(0, 40).map((a) => `<li class="k-${a.kind}"><time>${hms(a.t)}</time><span>${esc(a.text)}</span></li>`).join("");
    return `
      <div class="pb-head">Project browser <span>${S.panels.length} panels</span></div>
      ${lv}
      <div class="activity">
        <div class="pb-head">Activity <span>${S.activity.length ? "newest first" : ""}</span></div>
        ${acts ? `<ol>${acts}</ol>` : `<p class="empty">Nothing has run yet. Start with Run audit, or press Guided dry run to follow the full story.</p>`}
      </div>`;
  }

  // ---------------------------------------------------------------- audit view
  function viewAudit() {
    const sum = auditSummary();
    const acc = S.panels.filter((p) => p.review === "accepted").length;
    const flagged = S.panels.filter((p) => p.review !== "applied" && ["over", "locked"].includes(auditStatus(p))).length;
    const anyProp = S.panels.some((p) => p.proposal);
    const summary = sum
      ? `<b>${sum.n}</b> panels checked<span class="sep">·</span><b class="${sum.over ? "tx-alarm" : "tx-fix"}">${sum.over}</b> above ${S.cfg.target}%<span class="sep">·</span>worst: <b>${sum.worst.name}</b> at <b>${pct(sum.worst.audit.imb)}</b>`
      : `Nothing audited yet. The audit reads every panel and its circuits, computes the phase loads, and flags any panel above the ${S.cfg.target}% target. It changes nothing.`;
    return `<section class="view" aria-labelledby="h-audit">
      <div class="view-head">
        <div>
          <p class="eyebrow">Step 1 · Audit</p>
          <h1 id="h-audit">Project audit</h1>
          <p class="summary">${summary}</p>
        </div>
        <div class="actions">
          <button class="btn ${sum ? "" : "btn-primary"}" data-act="run-audit">${icon("scan")} ${sum ? "Re-run audit" : "Run audit"}</button>
          <button class="btn ${sum && flagged && !anyProp ? "btn-primary" : ""}" data-act="balance-all" ${sum && flagged ? "" : "disabled"}>${icon("bolt")} Balance all flagged${flagged ? ` (${flagged})` : ""}</button>
          <button class="btn ${acc ? "btn-primary" : ""}" data-act="apply-accepted" ${acc ? "" : "disabled"}>${icon("check")} Apply accepted${acc ? ` (${acc})` : ""}</button>
        </div>
      </div>
      <div class="audit-grid">${viewRiser()}${viewDumbbell()}</div>
      ${viewAuditTable()}
    </section>`;
  }

  function viewRiser() {
    const order = SP.levels.slice().reverse(); // bottom → top for scan timing
    const storeys = SP.levels.map((level) => {
      const fromBottom = order.indexOf(level);
      const cards = S.panels.filter((p) => p.level === level).map((p, i) => {
        const st = panelStatus(p);
        const a = live(p);
        const d = 260 + fromBottom * 430 + i * 110;
        return `<button class="rcard" data-act="open-panel" data-id="${p.id}" style="--d:${d}ms" aria-label="${p.name}, ${STATUS[st].label()}">
          <span class="plate">${p.name}</span>
          ${miniBars(a.loads, !!p.audit)}
          <span class="rcard-imb">${p.audit ? pct(a.imb) : "—"}</span>
          ${chip(st)}
          ${isStale(p) ? `<span class="stale" title="The model changed after the last audit">changed</span>` : ""}
          ${S.anim.audit ? `<span class="cover">reading…</span>` : ""}
        </button>`;
      }).join("");
      return `<div class="storey"><div class="storey-tag"><b>${level}</b><span>FFL ${FFL[level]} m</span></div><div class="storey-run">${cards}</div></div>`;
    }).join("");
    return `<div class="card riser ${S.anim.audit ? "scanning" : ""}">
      <div class="card-h"><h2>Riser</h2><span class="card-sub">Open any panel to see its board</span></div>
      <div class="riser-body">
        ${storeys}
        <div class="storey"><div class="storey-tag"><b>LV room</b><span>Level 01</span></div>
          <div class="storey-run"><div class="mdb"><span class="plate">MDB-01</span><span>Main distribution board · fed from TX-01, 1000 kVA, 11/0.4 kV</span></div></div>
        </div>
        <div class="scanline" aria-hidden="true"></div>
      </div>
    </div>`;
  }

  function viewDumbbell() {
    const rows = S.panels.filter((p) => p.audit).sort((a, b) => b.audit.baseline - a.audit.baseline);
    if (!rows.length) {
      return `<div class="card"><div class="card-h"><h2>Imbalance by panel</h2></div>
        <div class="empty-state"><p>Run the audit to plot every panel against the ${S.cfg.target}% target.</p>
        <button class="btn btn-primary" data-act="run-audit">${icon("scan")} Run audit</button></div></div>`;
    }
    const afterOf = (p) => {
      if (p.review === "applied") return live(p).imb;
      if (p.proposal && p.proposal.changes.length) return p.proposal.afterImb;
      return null;
    };
    const maxV = Math.max(30, ...rows.map((p) => p.audit.baseline));
    const top = Math.ceil(maxV / 10) * 10;
    const x = (v) => `${Math.min(100, v / top * 100).toFixed(2)}%`;
    const ticks = [];
    for (let v = 0; v <= top; v += top > 40 ? 20 : 10) ticks.push(v);
    const t = S.cfg.target;
    const body = rows.map((p) => {
      const b = p.audit.baseline, a = afterOf(p);
      const lo = a == null ? b : Math.min(a, b), hi = a == null ? b : Math.max(a, b);
      return `<div class="db-row">
        <button class="db-name" data-act="open-panel" data-id="${p.id}">${p.name}</button>
        <div class="db-track">
          <span class="axis"></span><span class="zone" style="width:${x(t)}"></span><span class="tline" style="left:${x(t)}"></span>
          ${a != null ? `<span class="link" style="left:${x(lo)};width:calc(${x(hi)} - ${x(lo)})"></span>` : ""}
          <span class="dot before ${b > t ? "over" : ""}" style="left:${x(b)}" title="As audited ${pct(b)}"></span>
          ${a != null ? `<span class="dot after ${a > t ? "miss" : ""}" style="left:${x(a)}" title="After ${pct(a)}"></span>` : ""}
        </div>
        <span class="db-val">${pct(b)}${a != null ? ` → <b class="${a > t ? "tx-warn" : "tx-fix"}">${pct(a)}</b>` : ""}</span>
      </div>`;
    }).join("");
    return `<div class="card">
      <div class="card-h"><h2>Imbalance by panel</h2>
        <div class="legend"><span><i class="sw" style="border:2.5px solid var(--alarm);background:var(--plate)"></i>As audited</span><span><i class="sw" style="background:var(--fix)"></i>After proposal</span><span><i class="sw" style="background:var(--fix-soft);border-radius:2px"></i>Within ${t}%</span></div>
      </div>
      <div class="db-rows">${body}</div>
      <div class="db-axis"><span></span><div class="ticks">${ticks.map((v) => `<span style="left:${x(v)}">${v}%</span>`).join("")}</div><span></span></div>
      <div class="card-b"><p class="hint">Imbalance is the largest deviation of any phase from the three-phase average, as a percentage of that average. Basis: ${S.cfg.basis} VA.</p></div>
    </div>`;
  }

  function viewAuditTable() {
    const audited = S.panels.some((p) => p.audit);
    const rows = S.panels.slice();
    const k = S.sort.key, dir = S.sort.dir;
    const val = (p) => {
      const a = live(p);
      return k === "name" ? p.name : k === "level" ? SP.levels.length - SP.levels.indexOf(p.level) : k === "A" || k === "B" || k === "C" ? a.loads[k] : k === "status" ? panelStatus(p) : a.imb;
    };
    rows.sort((a, b) => { const va = val(a), vb = val(b); return (va > vb ? 1 : va < vb ? -1 : 0) * dir; });
    const th = (key, label, r) => `<th class="${r ? "r" : ""}"><button class="sort-btn" data-act="sort" data-id="${key}" data-active="${k === key}">${label}${k === key ? (dir > 0 ? " ▲" : " ▼") : ""}</button></th>`;
    const body = rows.map((p) => {
      const a = live(p); const st = panelStatus(p); const pr = p.proposal;
      let prop = `<span class="tx-muted">—</span>`, act = "";
      if (pr && p.review !== "applied") {
        if (pr.status === "proposed") prop = `${plural(pr.changes.length, "move")} → <b class="tx-fix">${pct(pr.afterImb)}</b>`;
        else if (pr.status === "ok") prop = `<span class="tx-muted">No change needed</span>`;
        else prop = `<span class="tx-warn">Best ${pct(pr.afterImb)}</span>`;
        if (pr.status === "proposed" && !p.review) act = `<div class="actions"><button class="btn btn-sm" data-act="accept" data-id="${p.id}">${icon("check")} Accept</button><button class="btn btn-sm btn-ghost" data-act="reject" data-id="${p.id}">Reject</button></div>`;
        else if (p.review === "accepted") act = `<button class="btn btn-sm btn-ghost" data-act="unreview" data-id="${p.id}">Undo accept</button>`;
        else if (p.review === "rejected") act = `<button class="btn btn-sm btn-ghost" data-act="unreview" data-id="${p.id}">Reconsider</button>`;
        else if (pr.status === "needs" || pr.status === "locked") act = `<button class="btn btn-sm" data-act="open-panel" data-id="${p.id}">Open</button>`;
      } else if (p.review === "applied") {
        const t = S.tx.find((x) => x.panelId === p.id && !x.undone);
        prop = `<span class="tx-fix">Applied · ${plural(t ? t.changes : 0, "circuit")}</span>`;
        if (t) act = `<button class="btn btn-sm btn-ghost" data-act="undo" data-id="${t.id}">${icon("undo")} Undo</button>`;
      }
      return `<tr>
        <td><button class="link-btn" data-act="open-panel" data-id="${p.id}">${p.name}</button></td>
        <td>${p.level}</td><td>${esc(p.use)}</td>
        ${PHASES.map((ph) => `<td class="num r">${p.audit ? fmt(a.loads[ph]) : "—"}</td>`).join("")}
        <td class="num r"><b>${p.audit ? pct(a.imb) : "—"}</b></td>
        <td>${chip(st)}${p.audit && p.audit.zero ? ` <span class="chip chip-needs" title="Circuits without a load value">${icon("alert")}${plural(p.audit.zero, "circuit")} 0 VA</span>` : ""}</td>
        <td>${prop}</td><td>${act}</td>
      </tr>`;
    }).join("");
    return `<div class="card">
      <div class="card-h"><h2>Audit table</h2><span class="card-sub">${audited ? `Phase loads in VA, ${S.cfg.basis} basis. Sort by any column.` : "Values appear after the audit runs."}</span></div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr>${th("name", "Panel")}${th("level", "Level")}<th>Use</th>${th("A", "L<sub>A</sub>", 1)}${th("B", "L<sub>B</sub>", 1)}${th("C", "L<sub>C</sub>", 1)}${th("imb", "Imbalance", 1)}${th("status", "Status")}<th>Proposal</th><th>Review</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>
    </div>`;
  }

  // ---------------------------------------------------------------- workspace view
  function wsState(p) {
    const pr = p.proposal;
    const cur = live(p);
    if (p.review === "applied" && pr) return { mode: "applied", pr, cur, circuits: p.circuits, before: pr.before, beforeImb: pr.beforeImb, after: cur.loads, afterImb: cur.imb, b1: null };
    if (pr && S.boardMode === "proposed" && pr.changes.length) {
      return { mode: "proposed", pr, cur, circuits: pr.newCircuits, before: cur.loads, beforeImb: cur.imb, after: pr.after, afterImb: pr.afterImb };
    }
    return { mode: "drawn", pr, cur, circuits: p.circuits, before: cur.loads, beforeImb: cur.imb, after: null, afterImb: null };
  }

  function viewWorkspace() {
    const p = panel(S.sel);
    const W = wsState(p);
    const st = panelStatus(p);
    const pr = W.pr;
    const V = PM.VOLTAGES[S.cfg.voltage];
    const canToggle = pr && pr.changes.length && p.review !== "applied";
    return `<section class="view" aria-labelledby="h-ws">
      <div class="ws-head">
        <div class="ws-id">
          <h1 id="h-ws" class="sr">Panel ${p.name}</h1>
          <span class="plate plate-xl">${p.name}</span>
          <div>
            <div class="ws-spec">${V.label} · ${p.ways}-way · ${esc(p.main)} · ${p.level} · fed from ${esc(p.fedFrom)}</div>
            ${p.note ? `<div class="ws-note">${esc(p.note)}</div>` : `<div class="ws-spec">${esc(p.use)}</div>`}
            ${p.noteDetail ? `<div class="hint" style="max-width:80ch;margin-top:2px">${esc(p.noteDetail)}</div>` : ""}
          </div>
        </div>
        <div class="actions">${chip(st)}${isStale(p) ? `<span class="chip chip-needs">${icon("change")}Changed since audit</span>` : ""}</div>
      </div>
      <div class="card controls">
        <div class="ctl"><span class="ctl-label" id="lbl-appr">Approach</span>
          <div class="seg" role="group" aria-labelledby="lbl-appr">
            <button id="appr-mm" aria-pressed="${S.cfg.approach === "min_move"}" data-act="approach" data-id="min_move">Minimum moves</button>
            <button id="appr-lpt" aria-pressed="${S.cfg.approach === "lpt"}" data-act="approach" data-id="lpt">Fresh layout (LPT)</button>
          </div></div>
        <div class="ctl"><label class="ctl-label" for="target">Target</label>
          <input type="range" id="target" min="5" max="15" step="1" value="${S.cfg.target}" aria-describedby="target-out"><output id="target-out" for="target">${S.cfg.target}%</output></div>
        <div class="ctl"><span class="ctl-label" id="lbl-basis">Basis</span>
          <div class="seg" role="group" aria-labelledby="lbl-basis">
            <button id="basis-c" aria-pressed="${S.cfg.basis === "connected"}" data-act="basis" data-id="connected">Connected VA</button>
            <button id="basis-d" aria-pressed="${S.cfg.basis === "demand"}" data-act="basis" data-id="demand">Demand VA</button>
          </div></div>
        <div class="ctl-actions">
          <button class="btn btn-primary" id="run-copilot" data-act="run-copilot">${icon("bolt")} Run copilot</button>
          <button class="btn" data-act="design-change" title="Change one circuit's load, as happens during design development">${icon("change")} Simulate design change</button>
        </div>
      </div>
      <div class="ws-grid">
        <div class="card">
          <div class="card-h"><h2>Panelboard</h2>
            <div class="seg small" role="group" aria-label="Layout shown">
              <button id="bm-drawn" aria-pressed="${W.mode !== "proposed"}" data-act="board-mode" data-id="drawn">${p.review === "applied" ? "As applied" : "As drawn"}</button>
              <button id="bm-prop" aria-pressed="${W.mode === "proposed"}" data-act="board-mode" data-id="proposed" ${canToggle ? "" : "disabled"}>Proposed</button>
            </div>
            <div class="seg small" role="group" aria-label="Drawing style">
              <button id="bs-board" aria-pressed="${S.boardStyle === "board"}" data-act="board-style" data-id="board">Board</button>
              <button id="bs-sched" aria-pressed="${S.boardStyle === "schedule"}" data-act="board-style" data-id="schedule">Schedule</button>
            </div>
          </div>
          ${S.boardStyle === "board" ? viewBoard(p, W) : viewSchedule(p, W)}
          <div class="board-legend">
            <span><i class="lg-box locked"></i>Locked or DoNotMove (click the padlock)</span>
            <span><i class="lg-box pending"></i>Will move</span>
            <span><i class="lg-box moved"></i>Moved</span>
            <span><i class="lg-box space"></i>Space</span>
            <span>Click a breaker to inspect it</span>
          </div>
        </div>
        <div class="ws-side">
          ${viewReadout(p, W)}
          ${viewPhaseLoads(p, W)}
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
        cells += `<div class="space ${odd ? "L" : "R"} ${g ? "ghost" : ""}" style="${pos}"><span>${g ? `${esc(g.name)} moved to slot ${g.toSlot}` : "Space"}</span><span>${s}</span></div>`;
        continue;
      }
      if (c.slot !== s) continue;
      const phs = PM.phasesOf(c);
      const locked = PM.isLocked(c, S.cfg);
      const mv = M.moved.get(c.id), pd = M.pending.get(c.id);
      const va = PM.basisVA(c, S.cfg);
      const cls = ["brk", odd ? "L" : "R", c.spare ? "spare" : "", c.poles > 1 ? "multi" : "", locked ? "locked" : "", mv ? "moved" : "", pd ? "pending" : "", S.selCircuit === c.id ? "sel" : "", !c.spare && !(c.va > 0) ? "zero" : "", evalIds && evalIds.has(c.slot) ? "eval" : ""].filter(Boolean).join(" ");
      const lockTitle = c.lockedSlot && S.cfg.respectLocks ? "Engineer-locked slot. Click to unlock." : c.doNotMove ? "DoNotMove = Yes. Click to release." : "Click to flag DoNotMove";
      const meta = c.spare ? "no load" : `${c.poles}P · ${c.cls}${c.poles > 1 ? " · fixed" : ""}${!(c.va > 0) ? " · no load set" : ""}`;
      const vaHtml = c.spare ? "" : `<span class="brk-va"><b>${fmt(va)}</b><small>VA</small></span>`;
      const tag = mv ? `<span class="was">was ${mv.fromSlot} · ${mv.fromPhase}→${mv.toPhase}</span>` : pd ? `<span class="pend">→ ${pd.toSlot} (${pd.toPhase})</span>` : "";
      const d = evalIds && evalIds.has(c.slot) ? `--d:${(ev++) * 70}ms;` : "";
      cells += `<div class="${cls}" data-cid="${c.id}" data-act="pick-circuit" data-id="${c.id}" role="button" tabindex="0" style="${d}${pos}" aria-label="Circuit ${c.slot}, ${esc(c.spare ? "spare" : c.name)}, phase ${phs.join(" ")}${locked ? ", locked" : ""}">
        <span class="brk-no">${c.slot}</span>
        <span class="brk-body"><span class="brk-name" title="${esc(c.spare ? "Spare" : c.name)}">${esc(c.spare ? "Spare" : c.name)}</span><span class="brk-meta">${meta}</span></span>
        ${vaHtml}${tag}
        ${c.spare || c.poles > 1 ? "" : `<button class="brk-lock ${locked ? "on" : ""}" data-act="toggle-lock" data-id="${c.id}" aria-pressed="${locked}" title="${lockTitle}" aria-label="${lockTitle}">${icon(locked ? "lock" : "unlock")}</button>`}
        <span class="brk-handle">${phs.map((ph) => `<i class="ph-${ph}"></i>`).join("")}</span>
      </div>`;
    }
    return `<div class="board-wrap"><div class="board-frame">
      <div class="board-headrow"><span>Odd · left</span><span class="bus-labels"><b class="ph-A">A</b><b class="ph-B">B</b><b class="ph-C">C</b></span><span>Even · right</span></div>
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
      const l = occ.get(2 * r - 1), rt = occ.get(2 * r);
      taps += `<line class="tap ${ph} ${l ? "" : "faint"}" x1="0" y1="${y}" x2="${X[ph]}" y2="${y}"/>`;
      taps += `<line class="tap ${ph} ${rt ? "" : "faint"}" x1="${X[ph]}" y1="${y}" x2="${W}" y2="${y}"/>`;
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
      if (!c) { const g = M.ghosts.get(s); return { ckt: s, desc: g ? `<span class="tx-fix">moved to ${g.toSlot}</span>` : `<span class="muted">Space</span>`, va: "", poles: "", share: 0, moved: false }; }
      const share = PM.basisVA(c, S.cfg) / c.poles;
      if (c.slot !== s) return { ckt: s, desc: `<span class="muted">↳ ${c.slot} (${c.poles}-pole)</span>`, va: "", poles: "", share, moved: false };
      const mv = M.moved.get(c.id), pd = M.pending.get(c.id);
      return { ckt: s, desc: `${esc(c.spare ? "Spare" : c.name)}${PM.isLocked(c, S.cfg) ? ` ${icon("lock")}` : ""}${mv ? ` <span class="was">was ${mv.fromSlot}</span>` : pd ? ` <span class="pend">→ ${pd.toSlot}</span>` : ""}`, va: c.spare ? "" : fmt(PM.basisVA(c, S.cfg)), poles: c.spare ? "" : c.poles, share, moved: !!mv };
    };
    let body = "";
    for (let r = 1; r <= rows; r++) {
      const ph = PM.phaseOfSlot(2 * r - 1);
      const L = side(2 * r - 1), R = side(2 * r);
      const pc = PHASES.map((q) => q === ph ? `<td class="pc live ph-${q}">${L.share || R.share ? `${L.share ? fmt(L.share) : "–"} | ${R.share ? fmt(R.share) : "–"}` : "–"}</td>` : `<td class="pc"></td>`).join("");
      body += `<tr><td class="ckt">${L.ckt}</td><td class="desc ${L.moved ? "side-moved" : ""}">${L.desc}</td><td class="va">${L.va}</td><td class="muted">${L.poles}</td>${pc}<td class="muted">${R.poles}</td><td class="va">${R.va}</td><td class="desc ${R.moved ? "side-moved" : ""}">${R.desc}</td><td class="ckt">${R.ckt}</td></tr>`;
    }
    const loads = W.mode === "proposed" ? W.after : live(p).loads;
    const imb = PB.imbalancePct(loads);
    return `<div class="board-wrap"><table class="sched">
      <thead><tr><th>Ckt</th><th>Circuit description</th><th class="r">VA</th><th>P</th><th class="pc ph-A">A</th><th class="pc ph-B">B</th><th class="pc ph-C">C</th><th>P</th><th class="r">VA</th><th>Circuit description</th><th>Ckt</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td colspan="4">Total per phase (VA)</td>${PHASES.map((q) => `<td class="pc">${fmt(loads[q])}</td>`).join("")}<td colspan="4">Imbalance ${pct(imb)}</td></tr></tfoot>
    </table></div>`;
  }

  function vizMemo(p) { return S.viz[p.id] || (S.viz[p.id] = {}); }

  function viewReadout(p, W) {
    const memo = vizMemo(p);
    const showAfter = W.mode !== "drawn";
    const val = showAfter ? W.afterImb : W.beforeImb;
    const from = memo.imb == null ? val : memo.imb;
    const t = S.cfg.target;
    const top = Math.max(30, Math.ceil(Math.max(W.beforeImb, W.afterImb || 0) / 10) * 10);
    const x = (v) => `${Math.min(100, v / top * 100).toFixed(2)}%`;
    const ticks = []; for (let v = 0; v <= top; v += top > 40 ? 20 : 10) ticks.push(v);
    const pr = W.pr;
    const hint = W.mode === "drawn" && pr && pr.changes.length ? `<p class="readout-note">Proposal ready: <b class="tx-fix">${pct(pr.afterImb)}</b> with ${plural(pr.changes.length, "circuit")} renumbered. Switch to Proposed to see it.</p>` : "";
    const avg = (W.before.A + W.before.B + W.before.C) / 3;
    return `<div class="card readout">
      <div class="readout-top">
        ${showAfter ? `<div><span class="k">Before</span><span class="imb-before">${pct(W.beforeImb)}</span></div><span class="imb-arrow">${icon("arrow")}</span>` : ""}
        <div><span class="k">${showAfter ? (W.mode === "applied" ? "Now" : "After") : "Imbalance"}</span>
          <span class="imb-big ${val > t ? "tx-alarm" : "tx-fix"}" data-tween-from="${from}" data-tween-to="${val}">${pct(val)}</span></div>
      </div>
      <div>
        <div class="gauge" role="img" aria-label="Imbalance ${pct(val)} against a ${t}% target">
          <span class="g-ok" style="width:${x(t)}"></span>
          ${showAfter ? `<span class="g-mark before" style="left:${x(W.beforeImb)}"></span>` : ""}
          <span class="g-mark ${showAfter ? "after" : val > t ? "before" : "after"}" style="left:${x(val)}"></span>
        </div>
        <div class="gauge-scale">${ticks.map((v) => `<span style="left:${x(v)}">${v}%</span>`).join("")}</div>
      </div>
      <p class="readout-note">Largest phase deviation from the ${fmt(showAfter ? (W.after.A + W.after.B + W.after.C) / 3 : avg)} VA average. Target ≤ ${t}%, ${S.cfg.basis} basis.</p>
      ${hint}
    </div>`;
  }

  function viewPhaseLoads(p, W) {
    const memo = vizMemo(p);
    const showAfter = W.mode !== "drawn";
    const shown = showAfter ? W.after : W.before;
    const avg = (shown.A + shown.B + shown.C) / 3;
    const t = S.cfg.target / 100;
    const max = Math.max(W.before.A, W.before.B, W.before.C, showAfter ? Math.max(W.after.A, W.after.B, W.after.C) : 0, avg * (1 + t)) * 1.06 || 1;
    const x = (v) => `${(v / max * 100).toFixed(2)}%`;
    const prevW = memo.bars || {};
    const rows = PHASES.map((ph) => {
      const w = x(shown[ph]);
      const w0 = prevW[ph] || w;
      return `<div class="pl-row ph-${ph}">
        <span class="pl-tag">${ph}</span>
        <div class="pl-main">
          <div class="pl-track">
            <span class="pl-band" style="left:${x(avg * (1 - t))};width:${x(avg * 2 * t)}"></span>
            ${showAfter ? `<span class="pl-before" style="width:${x(W.before[ph])}"></span>` : ""}
            <span class="pl-bar" data-w="${w}" style="width:${w0}"></span>
            <span class="pl-avg" style="left:${x(avg)}"></span>
          </div>
          <div class="pl-vals">
            <span>${showAfter ? `${fmt(W.before[ph])} → <b>${fmt(W.after[ph])}</b>` : `<b>${fmt(W.before[ph])}</b>`} VA</span>
            <span>${showAfter ? `${amp(W.before[ph])} → <b>${amp(W.after[ph])}</b>` : `<b>${amp(W.before[ph])}</b>`} A</span>
          </div>
        </div>
      </div>`;
    }).join("");
    memo.barsNext = Object.fromEntries(PHASES.map((ph) => [ph, x(shown[ph])]));
    return `<div class="card">
      <div class="card-h"><h2>Phase loading</h2><span class="card-sub">${PM.VOLTAGES[S.cfg.voltage].ln} V line to neutral</span></div>
      <div class="pl">${rows}
        <div class="pl-foot">
          <span><i class="lg-box" style="background:var(--fix-soft);border-color:var(--fix)"></i>Band each phase must sit inside for ≤ ${S.cfg.target}%</span>
          <span><i style="display:inline-block;width:0;height:12px;border-left:1.5px dashed var(--ink-2)"></i>Average ${fmt(avg)} VA</span>
          ${showAfter ? `<span><i class="lg-box" style="border:1.5px dashed var(--ink-2);background:transparent"></i>Before</span>` : ""}
        </div>
      </div>
    </div>`;
  }

  function onePoleLoadsOf(p, circuits) { return PM.onePoleLoads({ ways: p.ways, circuits }, S.cfg); }

  function viewPhasor(p, W) {
    const vln = PM.VOLTAGES[S.cfg.voltage].ln;
    const curL = onePoleLoadsOf(p, W.mode === "applied" && W.pr ? W.pr.newCircuits : p.circuits);
    const beforeL = W.mode === "applied" && W.pr ? onePoleLoadsOf(p, panelBefore(p)) : onePoleLoadsOf(p, p.circuits);
    const showAfter = W.mode !== "drawn";
    const afterL = showAfter ? (W.mode === "applied" ? curL : onePoleLoadsOf(p, W.circuits)) : null;
    const shown = showAfter ? afterL : beforeL;
    const In = PM.neutralCurrent(shown, vln), In0 = PM.neutralCurrent(beforeL, vln);
    const cur = { a: shown.A / vln, b: shown.B / vln, c: shown.C / vln };
    const scaleMax = Math.max(beforeL.A, beforeL.B, beforeL.C, afterL ? Math.max(afterL.A, afterL.B, afterL.C) : 0) / vln || 1;
    return `<div class="card">
      <div class="card-h"><h2>Neutral current</h2><span class="card-sub">Phasor view</span></div>
      <div class="phasor-wrap">
        <svg class="phasor" id="phasor" viewBox="-100 -100 200 200" data-a="${cur.a}" data-b="${cur.b}" data-c="${cur.c}" data-max="${scaleMax}" role="img" aria-label="Phasor diagram. Estimated neutral current ${In.toFixed(1)} amps.">
          <circle class="ring" r="78"/><circle class="ring" r="39"/>
          <line class="axis" x1="0" y1="0" x2="0" y2="-88"/><line class="axis" x1="0" y1="0" x2="76" y2="44"/><line class="axis" x1="0" y1="0" x2="-76" y2="44"/>
          <g id="ph-vecs"></g>
        </svg>
        <div class="phasor-copy">
          <span class="k">Estimated neutral current</span>
          <span class="neutral-big">${showAfter ? `<span class="tx-muted" style="text-decoration:line-through">${In0.toFixed(1)}</span> → ` : ""}${In.toFixed(1)} A</span>
          <p class="hint">From single-pole loads at unity power factor. A balanced panel cancels on the neutral; every volt-amp of imbalance returns along it.</p>
        </div>
      </div>
    </div>`;
  }
  function panelBefore(p) {
    const t = S.tx.find((x) => x.panelId === p.id && !x.undone);
    return t ? t.prev : p.circuits;
  }

  function drawPhasor(svg, v, max) {
    const R = 78;
    const ang = { a: -90, b: 30, c: 150 }; // A up, B lower right, C lower left (screen coordinates)
    const pt = (k, mag) => { const r = (mag / max) * R, th = ang[k] * Math.PI / 180; return [r * Math.cos(th), r * Math.sin(th)]; };
    const arrow = (x, y, cls, label) => {
      const len = Math.hypot(x, y);
      if (len < 0.5) return `<circle class="head ${cls}" r="3"/>`;
      const ux = x / len, uy = y / len, hx = x - ux * 7, hy = y - uy * 7;
      const px = -uy * 4.5, py = ux * 4.5;
      const lx = x + ux * 11, ly = y + uy * 11 + 4;
      return `<line class="vec ${cls}" x1="0" y1="0" x2="${hx.toFixed(2)}" y2="${hy.toFixed(2)}"/>` +
        `<path class="head ${cls}" d="M${x.toFixed(2)},${y.toFixed(2)} L${(hx + px).toFixed(2)},${(hy + py).toFixed(2)} L${(hx - px).toFixed(2)},${(hy - py).toFixed(2)} Z"/>` +
        (label ? `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle">${label}</text>` : "");
    };
    const A = pt("a", v.a), B = pt("b", v.b), C = pt("c", v.c);
    const N = [A[0] + B[0] + C[0], A[1] + B[1] + C[1]];
    svg.querySelector("#ph-vecs").innerHTML = arrow(A[0], A[1], "A", "A") + arrow(B[0], B[1], "B", "B") + arrow(C[0], C[1], "C", "C") + arrow(N[0], N[1], "N", Math.hypot(N[0], N[1]) > 6 ? "N" : "");
  }

  function viewInspector(p) {
    const c = p.circuits.find((x) => x.id === S.selCircuit);
    if (!c) return "";
    const phs = PM.phasesOf(c).join(" + ");
    const sheets = (c.sheets || []).map((s) => `<span class="sheet-tag ${s.issued ? "issued" : ""}" title="${esc(s.title)}">${s.id} ${s.issued ? `issued ${s.rev}` : s.rev}</span>`).join("");
    const lockable = !c.spare && c.poles === 1;
    return `<div class="card">
      <div class="card-h"><h2>Circuit ${c.slot}</h2><button class="btn btn-sm btn-ghost" data-act="close-insp">Close</button></div>
      <div class="insp">
        <p><b>${esc(c.spare ? "Spare breaker" : c.name)}</b></p>
        <dl class="insp-grid">
          <dt>Phase</dt><dd class="mono">${phs} · ${c.poles}-pole${c.poles > 1 ? " · fixed (R2)" : ""}</dd>
          ${c.spare ? "" : `<dt>Class</dt><dd>${CLS[c.cls]} · demand factor ${S.cfg.demandFactors[c.cls]}</dd>
          <dt><label for="insp-va">Load</label></dt><dd><input type="number" id="insp-va" min="0" step="50" value="${c.va}"> VA</dd>`}
          ${lockable ? `<dt>Locks</dt><dd style="display:flex;flex-direction:column;gap:6px">
            <label class="check"><input type="checkbox" id="insp-dnm" ${c.doNotMove ? "checked" : ""}> DoNotMove = Yes</label>
            <label class="check"><input type="checkbox" id="insp-ls" ${c.lockedSlot ? "checked" : ""}> Engineer-locked slot</label></dd>` : ""}
          ${sheets ? `<dt>Tagged on</dt><dd>${sheets}</dd>` : ""}
        </dl>
        <p class="hint">Changing the load or a lock re-runs any open proposal for this panel.</p>
      </div>
    </div>`;
  }

  function describeStep(st) {
    if (st.kind === "move") return `move circuit ${st.numbers[0]} from ${st.from[0]} to ${st.to[0]}`;
    return `swap circuits ${st.numbers[0]} and ${st.numbers[1]} (${st.from[0]} ↔ ${st.from[1]})`;
  }

  function viewTrace(p, pr) {
    const reveal = !!S.anim.trace;
    let items = "";
    let d = 0;
    const li = (html, cls) => `<li class="${cls || ""} ${reveal ? "reveal" : ""}" style="--d:${(d++) * 380}ms">${html}</li>`;
    if (pr.approach === "lpt") {
      const mv = PM.toCore(p, S.cfg).filter(PB.isMovable).length;
      items += li(`Sorted ${plural(mv, "movable circuit")} by load, largest first.`);
      items += li(`Placed each one on whichever phase was lightest at that moment, ignoring where it was drawn.`);
      items += li(`Result ${pct(pr.afterImb)} with ${plural(pr.changes.length, "circuit")} renumbered.`, "stop");
    } else {
      const T = pr.trace;
      if (!T.length) items += li(`Imbalance ${pct(pr.beforeImb)} is already within the ${pr.target}% target. Nothing to search.`, "stop");
      for (const t of T) {
        const evald = `Evaluated ${plural(t.evaluatedMoves, "single move")} and ${plural(t.evaluatedSwaps, "swap")}${t.blockedByCapacity ? `; ${plural(t.blockedByCapacity, "move")} skipped because the target phase has no free slot` : ""}.`;
        if (t.step) items += li(`<b>Imbalance ${pct(t.before)}.</b> ${evald} Best: ${describeStep(t.step)}, removing ${t.gainPerCircuit.toFixed(1)} points per circuit renumbered. <span class="muted">Now ${pct(t.step.after)}.</span>`);
        else items += li(`<b>Imbalance ${pct(t.before)}.</b> ${evald} None of them improves balance.`);
      }
      const why = { "target met": `target of ${pr.target}% met`, "no improving move": "no move or swap improves balance further", "iteration limit": "iteration limit reached" }[T.stopReason] || T.stopReason;
      if (T.length) items += li(`Stopped: ${why}.`, "stop");
    }
    const cap = pr.slotCapacity;
    return `<div class="card trace">
      <div class="card-h"><h2>How the copilot decided</h2><span class="card-sub">${pr.approach === "lpt" ? "Greedy LPT" : "Minimum-move local search"} · capacity A ${cap.A} · B ${cap.B} · C ${cap.C} slots</span></div>
      <ol>${items}</ol>
      <div class="explain">
        <p>${esc(explain(p, pr))}</p>
        <p class="hint">Plain-language summary written by a fixed template from the change list. In production an approved LLM may phrase it; it never calculates loads or chooses placements.</p>
      </div>
    </div>`;
  }

  function explain(p, pr) {
    const L = pr.before, avg = (L.A + L.B + L.C) / 3;
    const [hp, hd] = PHASES.map((ph) => [ph, L[ph] - avg]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
    if (pr.status === "ok" && pr.approach !== "lpt") return `${p.name} sits at ${pct(pr.beforeImb)}, inside the ${pr.target}% target. No circuits need to move.`;
    const origin = p.review === "applied" ? panelBefore(p) : p.circuits;
    let s = `${p.name} was ${pct(pr.beforeImb)} unbalanced. Phase ${hp} carried ${fmt(L[hp])} VA, ${fmt(Math.abs(hd))} VA ${hd > 0 ? "above" : "below"} the ${fmt(avg)} VA average.`;
    const ones = origin.filter((c) => !c.spare && c.poles === 1).sort((a, b) => b.va - a.va);
    if (hd > 0 && ones[0] && PM.phaseOfSlot(ones[0].slot) === hp) s += ` It holds the largest single-pole load, ${ones[0].name} at ${fmt(ones[0].va)} VA.`;
    const ch = pr.changes;
    if (ch.length === 1) s += ` Moving ${ch[0].name} (${fmt(ch[0].va)} VA) from phase ${ch[0].fromPhase} to phase ${ch[0].toPhase} brings every phase within ${pct(pr.afterImb)} of the average. No other circuit changes.`;
    else if (ch.length === 2 && ch[0].kind === "swap") s += ` Swapping ${ch[0].name} (${fmt(ch[0].va)} VA, phase ${ch[0].fromPhase}) with ${ch[1].name} (${fmt(ch[1].va)} VA, phase ${ch[1].fromPhase}) brings every phase within ${pct(pr.afterImb)} of the average. Two circuits are renumbered.`;
    else if (ch.length) s += ` ${ch.length} circuits change slots, bringing every phase within ${pct(pr.afterImb)} of the average.`;
    const locked = origin.filter((c) => !c.spare && c.poles === 1 && PM.isLocked(c, S.cfg));
    if (locked.length && ch.length) s += ` ${locked.length === 1 ? "One locked circuit" : `${locked.length} locked circuits`} stayed where ${locked.length === 1 ? "it was" : "they were"}.`;
    if (pr.status === "needs" || pr.status === "locked") s += ` ${pr.reason}`;
    return s;
  }

  function viewReview(p, W) {
    const pr = W.pr;
    if (!pr) {
      return `<div class="card"><div class="dialog-h"><h2>Review proposal</h2><span class="txn">Nothing proposed yet</span></div>
        <div class="empty-state">
          <p>Run the copilot to search for the fewest circuit moves that bring ${p.name} inside ${S.cfg.target}%. You review every change before anything is written to the model.</p>
          <button class="btn btn-primary" data-act="run-copilot">${icon("bolt")} Run copilot on ${p.name}</button>
        </div></div>`;
    }
    const txName = `Phase Balancer – ${p.name}`;
    let banner = "";
    if (pr.status === "ok" && pr.approach !== "lpt") banner = `<div class="banner banner-ok">${icon("check")}<p>${esc(pr.reason)}</p></div>`;
    if (pr.status === "needs") banner = `<div class="banner banner-needs">${icon("alert")}<p><b>Needs engineer.</b> ${esc(pr.reason)}</p></div>`;
    if (pr.status === "locked") banner = `<div class="banner banner-locked">${icon("lock")}<p><b>Locked-limited.</b> ${esc(pr.reason)}</p></div>`;
    const warns = pr.warnings.map((w) => `<div class="banner banner-warn">${icon("alert")}<p>${esc(w)}</p></div>`).join("");
    const rows = pr.changes.map((c) => `<tr>
      <td class="ckt">${c.fromSlot}</td>
      <td class="cname">${esc(c.name)}<span class="kind">${c.kind === "swap" ? `swap with ${c.partnerSlot}` : "move to free slot"}</span></td>
      <td class="num r">${fmt(c.va)} VA</td>
      <td class="slot">slot ${c.fromSlot}<i class="ph-${c.fromPhase}">${c.fromPhase}</i></td>
      <td class="slot">${icon("arrow")} slot ${c.toSlot}<i class="ph-${c.toPhase}">${c.toPhase}</i></td>
      <td class="newno">${c.toSlot}</td>
      <td>${(c.sheets || []).map((s) => `<span class="sheet-tag ${s.issued ? "issued" : ""}">${s.id}</span>`).join("")}</td>
    </tr>`).join("");
    const spares = pr.spareMoves.length ? `<p class="hint" style="padding:8px 16px 0">Spare breaker${pr.spareMoves.length > 1 ? "s" : ""} relocated: ${pr.spareMoves.map((m) => `slot ${m.fromSlot} → ${m.toSlot}`).join(", ")} (R7).</p>` : "";
    const t = S.tx.find((x) => x.panelId === p.id && !x.undone);
    let buttons;
    if (p.review === "applied") buttons = `<span class="chip chip-applied">${icon("check")}Applied as “${esc(txName)}”</span>${t ? `<button class="btn" data-act="undo" data-id="${t.id}">${icon("undo")} Undo transaction</button>` : ""}`;
    else if (p.review === "rejected") buttons = `<span class="chip chip-rejected">${icon("x")}Rejected and logged</span><button class="btn" data-act="unreview" data-id="${p.id}">Reconsider</button>`;
    else if (pr.changes.length) buttons = `<button class="btn btn-primary" id="btn-apply" data-act="apply" data-id="${p.id}">${icon("check")} ${pr.status === "proposed" ? "Apply" : "Apply best effort"}</button>
      <button class="btn" data-act="reject" data-id="${p.id}">Reject</button>
      <button class="btn btn-ghost" data-act="focus-target">Re-run with a different target</button>`;
    else buttons = `<button class="btn btn-ghost" data-act="focus-target">Re-run with a different target</button>`;
    const sheetsAll = new Set(); for (const c of pr.changes) for (const s of c.sheets || []) sheetsAll.add(s.id);
    return `<div class="review-grid">
      <div class="card dialog">
        <div class="dialog-h"><h2>Review proposal</h2><span class="txn">Transaction: ${esc(txName)}</span></div>
        ${banner}${warns}
        ${rows ? `<div class="table-wrap"><table class="tbl chg"><thead><tr><th>Ckt</th><th>Circuit</th><th class="r">Load</th><th>From</th><th>To</th><th>New no.</th><th>Sheets</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
        ${spares}
        <div class="dialog-foot">
          <div class="metrics">
            <span><b>${plural(pr.changes.length, "circuit")}</b> renumbered</span>
            <span>${pct(pr.beforeImb)} → <b>${pct(pr.afterImb)}</b></span>
            <span>${plural(sheetsAll.size, "sheet")} with tag changes</span>
            <span>Read-back ${pr.readBackOk ? `<b class="tx-fix">±1 VA ✓</b>` : `<b class="tx-alarm">mismatch</b>`}</span>
          </div>
          <div class="actions">${buttons}</div>
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
    const issuedOf = (pr) => { const s = new Set(); for (const c of pr.changes) for (const sh of c.sheets || []) if (sh.issued) s.add(sh.id); return s; };
    const cols = [
      { key: "drawn", title: "As drawn", sub: "Circuits in modelling order", circuits: p.circuits, loads: cur.loads, imb: cur.imb, changes: [], status: auditStatus(p) === "unknown" ? (cur.imb > S.cfg.target ? "over" : "ok") : auditStatus(p) },
      { key: "lpt", title: "Fresh layout (LPT)", sub: "Largest load to the lightest phase", circuits: lpt.newCircuits, loads: lpt.after, imb: lpt.afterImb, changes: lpt.changes, status: lpt.afterImb <= S.cfg.target ? "ok" : "over", pr: lpt },
      { key: "mm", title: "Minimum moves", sub: "Default · fewest circuits renumbered", circuits: mm.newCircuits, loads: mm.after, imb: mm.afterImb, changes: mm.changes, status: mm.afterImb <= S.cfg.target ? "ok" : mm.status === "locked" ? "locked" : "needs", pr: mm, best: true },
    ];
    const both = lpt.afterImb <= S.cfg.target && mm.afterImb <= S.cfg.target;
    let pitch;
    if (cur.imb <= S.cfg.target) pitch = `${p.name} is already within ${S.cfg.target}%. Minimum moves leaves it alone; a fresh layout would still renumber <em>${plural(lpt.changes.length, "circuit")}</em>.`;
    else if (both) pitch = `Both reach the target. Minimum moves renumbers <em>${plural(mm.changes.length, "circuit")}</em>; a fresh layout renumbers ${plural(lpt.changes.length, "circuit")}.`;
    else pitch = `Minimum moves reaches ${pct(mm.afterImb)} with ${plural(mm.changes.length, "circuit")} renumbered; a fresh layout reaches ${pct(lpt.afterImb)} with ${plural(lpt.changes.length, "circuit")}.`;
    const options = S.panels.map((q) => `<option value="${q.id}" ${q.id === p.id ? "selected" : ""}>${q.name} · ${esc(q.use)}</option>`).join("");
    const col = (c) => {
      const moved = new Map(c.changes.map((ch) => [ch.id, ch]));
      const occ = new Map(); for (const k of c.circuits) for (const s of PM.slotsOf(k)) occ.set(s, k);
      let cells = "";
      for (let s = 1; s <= p.ways; s++) {
        const k = occ.get(s); const ph = PM.phaseOfSlot(s);
        if (!k || k.spare) { cells += `<div class="sm ph-${ph}" title="Slot ${s}, phase ${ph}">${s}<span class="va">${k ? "spare" : ""}</span></div>`; continue; }
        const mv = moved.get(k.id);
        const share = PM.basisVA(k, S.cfg) / k.poles;
        cells += `<div class="sm load ph-${ph} ${mv ? "moved" : ""} ${PM.isLocked(k, S.cfg) ? "locked" : ""}" title="${esc(k.name)} · slot ${s}, phase ${ph}${mv ? ` · was slot ${mv.fromSlot}` : ""}"><b>${s}</b>${mv ? `<span>← ${mv.fromSlot}</span>` : ""}<span class="va">${fmt(share)}</span></div>`;
      }
      const issued = c.pr ? issuedOf(c.pr) : new Set();
      const sheets = new Set(); for (const ch of c.changes) for (const sh of ch.sheets || []) sheets.add(sh.id);
      const max = Math.max(c.loads.A, c.loads.B, c.loads.C) || 1;
      return `<div class="card cmp-col ${c.best ? "best" : ""}">
        <div class="card-h"><h2>${c.title}</h2>${chip(c.status)}<span class="card-sub" style="flex-basis:100%">${c.sub}</span></div>
        <div class="cmp-stats">
          <div><span class="k">Imbalance</span><span class="v ${c.imb > S.cfg.target ? "tx-alarm" : "tx-fix"}">${pct(c.imb)}</span></div>
          <div><span class="k">Renumbered</span><span class="v">${c.key === "drawn" ? "–" : c.changes.length}</span></div>
        </div>
        <div class="pl" style="padding-bottom:4px">${PHASES.map((ph) => `<div class="pl-row ph-${ph}"><span class="pl-tag">${ph}</span><div class="pl-main"><div class="pl-track"><span class="pl-bar" style="width:${(c.loads[ph] / max * 92).toFixed(1)}%"></span></div><div class="pl-vals"><span><b>${fmt(c.loads[ph])}</b> VA</span></div></div></div>`).join("")}</div>
        <div class="slotmap" aria-label="Slot map">${cells}</div>
        <div class="cmp-list">
          ${c.key === "drawn" ? `<span>The layout as currently modelled.</span>` : c.changes.length ? `<span><b>${plural(sheets.size, "sheet")}</b> with circuit tags to update${issued.size ? `, <b class="tx-warn">${issued.size} already issued</b>` : ""}</span><div class="sheets">${[...sheets].map((id) => `<span class="sheet-tag ${issued.has(id) ? "issued" : ""}">${id}</span>`).join("")}</div>` : `<span>No circuit changes.</span>`}
        </div>
      </div>`;
    };
    return `<section class="view" aria-labelledby="h-cmp">
      <div class="view-head">
        <div>
          <p class="eyebrow">Steps 2–3 · Optimise and propose</p>
          <h1 id="h-cmp">Approach comparison</h1>
          <p class="cmp-pitch" style="margin-top:10px">${pitch}</p>
        </div>
        <div class="actions" style="align-items:center">
          <label class="ctl-label" for="cmp-panel">Panel</label>
          <select id="cmp-panel">${options}</select>
          <button class="btn" data-act="cmp-worked">Load the worked example</button>
        </div>
      </div>
      <div class="cmp-grid">${cols.map(col).join("")}</div>
      <p class="hint">Both approaches run on the same core and the same ${S.cfg.target}% target. The fresh layout suits panels with no drawings issued yet; minimum moves suits panels already on issued sheets, because every renumbered circuit means re-tagging plans and homerun annotations.</p>
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
      { id: "O1", name: "Panels audited automatically before issue", val: audited ? `${Math.round(audited / n * 100)}%` : "–", target: "100%", met: audited === n },
      { id: "O2", name: `Panels within ${S.cfg.target}% now`, val: audited ? `${within}/${n}` : "–", target: `≥ 95%, others flagged (${flaggedWithReason} flagged)`, met: audited && (within / n >= 0.95 || within + flaggedWithReason === n) },
      { id: "O3", name: "Average circuits renumbered per corrected panel", val: avgMoves == null ? "–" : avgMoves.toFixed(1), target: "≤ 3", met: avgMoves != null && avgMoves <= 3 },
      { id: "O4", name: "Engineer minutes per panel", val: "Measure in pilot week 1", na: true, target: "from ~15–20 to ≤ 3", met: null },
      { id: "O5", name: "Decisions with a before/after record", val: acted.length ? `${Math.round(logged / acted.length * 100)}%` : "–", target: "100%", met: acted.length && logged === acted.length },
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
      <span class="ktarget">Pilot target ${k.target}</span>
      ${k.met === null ? `<span class="chip chip-unknown">${icon("dot")}Not measured in a dry run</span>` : k.met ? `<span class="chip chip-ok">${icon("check")}Met</span>` : `<span class="chip chip-unknown">${icon("dot")}Not yet</span>`}
    </div>`).join("");
    const logRows = S.log.slice().reverse().map((r) => `<tr>
      <td class="num nw">${r.timestamp.replace("T", " ")}</td><td><b>${r.panel}</b></td>
      <td class="num r nw">${fmt(r.LA_before)} / ${fmt(r.LB_before)} / ${fmt(r.LC_before)}</td><td class="num r">${r.imbalance_before_pct}%</td>
      <td class="num r nw">${fmt(r.LA_after)} / ${fmt(r.LB_after)} / ${fmt(r.LC_after)}</td><td class="num r">${r.imbalance_after_pct}%</td>
      <td class="num r">${r.circuits_moved}</td><td class="num" style="white-space:normal;min-width:180px">${esc(r.changes) || "–"}</td>
      <td>${esc(r.status)}</td><td>${esc(r.engineer)}</td></tr>`).join("");
    const txs = S.tx.map((t) => `<li class="${t.undone ? "undone" : ""}"><span class="tname">${esc(t.name)}</span>
      <span class="hint">${t.group ? esc(t.group) + " · " : ""}${plural(t.changes, "circuit")} · ${hms(t.at)}</span>
      ${t.undone ? `<span class="chip chip-rejected">Undone</span>` : `<button class="btn btn-sm" data-act="undo" data-id="${t.id}">${icon("undo")} Undo</button>`}</li>`).join("");
    return `<section class="view" aria-labelledby="h-rep">
      <div class="view-head">
        <div>
          <p class="eyebrow">Step 5 · Apply and report</p>
          <h1 id="h-rep">Report & log</h1>
          <p class="summary">Pilot success measures from §4, computed from this session. Every apply, reject and flagged panel writes a row to the change log.</p>
        </div>
        <div class="actions">
          ${S.dl === "local" || S.dl === "ok" ? `<button class="btn" data-act="csv-download" ${S.log.length ? "" : "disabled"}>${icon("download")} Download CSV</button>` : ""}
          <button class="btn" data-act="csv-copy" ${S.log.length ? "" : "disabled"}>${icon("copy")} Copy CSV</button>
        </div>
      </div>
      <div class="kpis">${tiles}</div>
      <div class="card"><div class="card-h"><h2>Transactions</h2><span class="card-sub">Each apply is one named, undoable model change</span></div>
        ${txs ? `<ul class="tx-list">${txs}</ul>` : `<div class="empty-state"><p>No transactions yet. Apply a proposal from the panel workspace or the audit table.</p></div>`}</div>
      <div class="card"><div class="card-h"><h2>Change log</h2><span class="card-sub">Columns follow §13.1 · VA per phase A / B / C</span></div>
        ${logRows ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Panel</th><th class="r">Before (VA)</th><th class="r">Imb.</th><th class="r">After (VA)</th><th class="r">Imb.</th><th class="r">Moved</th><th>Changes</th><th>Status</th><th>Engineer</th></tr></thead><tbody>${logRows}</tbody></table></div>`
        : `<div class="empty-state"><p>The log is empty. Rows appear when proposals are applied, rejected or flagged for an engineer.</p></div>`}</div>
      <div class="card"><div class="card-h"><h2>phase_balancer_log.csv</h2><span class="card-sub">What the pyRevit button would append</span></div>
        <pre class="csv" id="csv-pre" tabindex="0">${esc(csvText())}</pre></div>
    </section>`;
  }

  // ---------------------------------------------------------------- rules view
  const RULES = [
    ["R1", "Only 1-pole, unlocked circuits are movable", "Hard", "Multi-pole and locked circuits enter the core as fixed loads."],
    ["R2", "Multi-pole circuits stay put; load splits equally across their phases", "Hard", "A 2-pole adds half its load to each phase it spans, a 3-pole a third. See PP-1A and PP-R1."],
    ["R3", "Locked slots and DoNotMove circuits are never moved", "Hard", "Click any padlock on the panelboard. An open proposal re-runs and works around it."],
    ["R4", "1-pole circuits on a phase cannot exceed the slots that phase offers", "Hard", "Slot capacity per phase is passed to the search. RP-2B has no free C slots, so it can only swap."],
    ["R5", "Imbalance must be ≤ the target", "Goal", "Target slider from 5 to 15%. The search stops as soon as the target is met."],
    ["R6", "Minimise circuits renumbered", "Objective", "Each candidate is scored by imbalance removed per circuit renumbered; a swap counts as two."],
    ["R7", "Spares and spaces are valid targets; occupied slots change only through swaps", "Hard", "A displaced spare takes the vacated slot. See PP-1A."],
    ["R8", "Keep circuits from the same group together", "Soft (v2)", "Not simulated in v1."],
    ["R9", "Balance on connected or demand VA", "Config", "Basis toggle in the panel workspace. The demand factors in Settings are illustrative until the project standard is confirmed."],
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
    const obj = {
      imbalance_target_pct: c.target, balance_basis: c.basis, default_approach: c.approach,
      max_moves_per_panel: c.maxMoves, respect_locked_slots: c.respectLocks, do_not_move_parameter: c.doNotMoveParam,
      log_path: "./phase_balancer_log.csv", system_voltage: c.voltage, demand_factors: c.demandFactors,
    };
    return esc(JSON.stringify(obj, null, 2)).replace(/(&quot;[a-z_]+&quot;):/gi, '<span class="k1">$1</span>:').replace(/: (&quot;[^&]*&quot;|[\d.]+|true|false)/g, ': <span class="v1">$1</span>');
  }

  function viewRules() {
    const c = S.cfg;
    const checked = store.get("pbc-assumptions") || {};
    const tests = S.tests;
    return `<section class="view" aria-labelledby="h-rules">
      <div class="view-head"><div>
        <p class="eyebrow">Configuration</p>
        <h1 id="h-rules">Rules & config</h1>
        <p class="summary">Firm settings live in <span class="mono">config.json</span>, not in code. Change them here and every proposal re-runs.</p>
      </div></div>
      <div class="cfg-grid">
        <div class="card"><div class="card-h"><h2>Settings</h2></div>
          <div class="form">
            <label for="cfg-target">Imbalance target (%)</label><input type="number" id="cfg-target" min="1" max="30" step="1" value="${c.target}">
            <label for="cfg-basis">Balance basis</label><select id="cfg-basis"><option value="connected" ${c.basis === "connected" ? "selected" : ""}>Connected VA</option><option value="demand" ${c.basis === "demand" ? "selected" : ""}>Demand VA</option></select>
            <label for="cfg-approach">Default approach</label><select id="cfg-approach"><option value="min_move" ${c.approach === "min_move" ? "selected" : ""}>Minimum moves</option><option value="lpt" ${c.approach === "lpt" ? "selected" : ""}>Fresh layout (LPT)</option></select>
            <label for="cfg-maxmoves">Max moves per panel</label><input type="number" id="cfg-maxmoves" min="1" max="20" step="1" value="${c.maxMoves}">
            <label for="cfg-respect">Respect locked slots</label><span><input type="checkbox" id="cfg-respect" ${c.respectLocks ? "checked" : ""}></span>
            <label for="cfg-voltage">System voltage</label><select id="cfg-voltage">${Object.entries(PM.VOLTAGES).map(([k, v]) => `<option value="${k}" ${c.voltage === k ? "selected" : ""}>${v.label}</option>`).join("")}</select>
            <label for="cfg-engineer">Engineer (for the log)</label><input type="text" id="cfg-engineer" value="${esc(c.engineer)}">
            ${Object.keys(c.demandFactors).map((k) => `<label for="df-${k}">Demand factor · ${CLS[k]}</label><input type="number" id="df-${k}" min="0" max="1" step="0.05" value="${c.demandFactors[k]}">`).join("")}
          </div>
          <pre class="json" aria-label="config.json">${configJson()}</pre>
        </div>
        <div class="card"><div class="card-h"><h2>Core self-test</h2><button class="btn btn-sm" data-act="run-tests">${icon("check")} Run T1–T9</button></div>
          ${tests ? `<ul class="tests">${tests.map((t) => `<li><span class="${t.pass ? "pass" : "fail"}">${icon(t.pass ? "check" : "x")}</span><span class="tid">${t.id}</span><span>${esc(t.name)}<span class="detail">${esc(t.detail)}</span></span></li>`).join("")}</ul>`
          : `<div class="empty-state"><p>Runs the unit tests from §15.1 against the same core this page uses. The repository also checks the JavaScript port against the Python reference on 300 random panels.</p></div>`}
        </div>
      </div>
      <div class="card"><div class="card-h"><h2>Engineering rules</h2><span class="card-sub">§7</span></div>
        <div class="table-wrap"><table class="tbl rules"><thead><tr><th>ID</th><th>Rule</th><th>Type</th><th>How this dry run enforces it</th></tr></thead>
        <tbody>${RULES.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td><span class="type ${r[2] === "Hard" ? "hard" : ""}">${r[2]}</span></td><td>${r[3]}</td></tr>`).join("")}</tbody></table></div>
      </div>
      <div class="card"><div class="card-h"><h2>Assumptions to confirm with the technical directors</h2><span class="card-sub">§18 · ticks are kept in this browser only</span></div>
        <ul class="assume">${ASSUME.map((a, i) => `<li><label><input type="checkbox" id="as-${i}" ${checked[i] ? "checked" : ""}><span>${a}</span></label></li>`).join("")}</ul>
      </div>
    </section>`;
  }

  function runSelfTests() {
    const C = PB.Circuit, P = PHASES, r1 = (x) => Math.round(x * 10) / 10;
    const worked = () => [2400, 1800, 1500, 1500, 1200, 1000, 900, 800, 600].map((v, i) => C(2 * i + 1, v, [P[i % 3]]));
    const T = [];
    const add = (id, name, fn) => { try { const [pass, detail] = fn(); T.push({ id, name, pass, detail }); } catch (e) { T.push({ id, name, pass: false, detail: String(e) }); } };
    add("T1", "Worked example, minimum moves, target 5%", () => { const [r, m] = PB.minMoveBalance(worked(), { target_pct: 5 }); const i = r1(PB.imbalancePct(PB.phaseLoads(r))); return [i === 2.6 && m.size === 1 && m.has(13), `imbalance ${i}%, moved {${[...m]}}`]; });
    add("T2", "Worked example, fresh layout (LPT)", () => { const d = worked(), r = PB.lptBalance(d); const mv = r.filter((c, k) => c.phases[0] !== d[k].phases[0]).map((c) => c.number); const i = r1(PB.imbalancePct(PB.phaseLoads(r))); return [i === 2.6 && mv.join() === "7,11,13,15,17", `imbalance ${i}%, moved [${mv}]`]; });
    add("T3", "Already balanced panel", () => { const [, m] = PB.minMoveBalance([C(1, 1000, ["A"]), C(2, 1000, ["B"]), C(3, 1050, ["C"])], { target_pct: 10 }); return [m.size === 0, `${m.size} moves`]; });
    add("T4", "All circuits locked", () => { const p = { ways: 6, circuits: [1, 3, 5].map((s, k) => ({ id: "t" + s, slot: s, poles: 1, va: [3000, 500, 500][k], cls: "REC", doNotMove: true })) }; const a = PM.audit(p, S.cfg); return [a.status === "locked", `status ${a.status}`]; });
    add("T5", "Only 3-pole circuits", () => { const cs = [C(1, 9000, P), C(7, 4500, P)]; const i = PB.imbalancePct(PB.phaseLoads(cs)); const [, m] = PB.minMoveBalance(cs, { target_pct: 5 }); return [i === 0 && m.size === 0, `imbalance ${i}%, ${m.size} moves`]; });
    add("T6", "One huge 1-pole load", () => { const p = { ways: 12, circuits: [[1, 9000], [3, 1000], [5, 1000], [7, 1000]].map(([s, v]) => ({ id: "h" + s, slot: s, poles: 1, va: v, cls: "EQP" })) }; const r = PM.propose(p, S.cfg, "min_move"); return [!r.reached && r.status === "needs", `${r.status}, best achievable ${pct(r.afterImb)}`]; });
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
      caption: () => `Twelve 3-phase 4-wire panelboards across five levels of a sample building. Circuits went in by hand, in modelling order, and loads have changed since. Nobody has checked phase balance yet.` },
    { title: "Audit every panel", step: 1,
      run(fast) { runAudit(!fast); S.view = "audit"; },
      caption: () => { const s = auditSummary(); return `One click reads every panel and its circuits. ${s.n} panels checked · ${s.over} above ${S.cfg.target}% · worst: ${s.worst.name} at ${pct(s.worst.audit.imb)}. Nothing in the model has changed.`; } },
    { title: "Open LP-2A as drawn", step: 1,
      run() { S.sel = LP; S.view = "workspace"; S.boardMode = "drawn"; S.boardStyle = "board"; S.selCircuit = null; },
      caption: () => { const a = live(panel(LP)); const avg = a.total / 3; return `LP-2A is the worked example from the concept note. Phase A carries ${fmt(a.loads.A)} VA against an average of ${fmt(avg)} VA, so the panel sits at ${pct(a.imb)}, above the ${S.cfg.target}% target. Phase is fixed by slot row, so balancing means moving breakers.`; } },
    { title: "Search for the fewest moves", step: 2,
      run(fast) { const p = panel(LP); S.sel = LP; S.view = "workspace"; S.boardMode = "drawn"; propose(p, "min_move"); if (!fast) { S.anim.trace = true; S.anim.eval = true; } },
      caption: () => { const pr = panel(LP).proposal; const t = pr.trace[0]; return `The copilot tries every single move (${t.evaluatedMoves}) and every pairwise swap (${t.evaluatedSwaps}), and scores each by imbalance removed per circuit renumbered. One move clears the target, so the search stops after one iteration.`; } },
    { title: "The proposal", step: 3,
      run(fast) { S.sel = LP; S.view = "workspace"; if (fast) { S.boardMode = "proposed"; return null; } S.boardMode = "drawn"; return () => setTimeout(() => switchBoard("proposed"), 700); },
      caption: () => { const p = panel(LP), pr = p.proposal, c = pr.changes[0]; const v = PM.VOLTAGES[S.cfg.voltage].ln; const n0 = PM.neutralCurrent(PM.onePoleLoads(p, S.cfg), v), n1 = PM.neutralCurrent(PM.onePoleLoads({ circuits: pr.newCircuits }, S.cfg), v); return `Move “${c.name}” (${fmt(c.va)} VA) from slot ${c.fromSlot} on phase ${c.fromPhase} to slot ${c.toSlot} on phase ${c.toPhase}. Imbalance falls from ${pct(pr.beforeImb)} to ${pct(pr.afterImb)} and the estimated neutral current from ${n0.toFixed(1)} A to ${n1.toFixed(1)} A. One circuit is renumbered.`; } },
    { title: "Against a naive rebalance", step: 3,
      run() { S.view = "compare"; S.compare = LP; },
      caption: () => { const p = panel(LP); const l = PM.propose(p, S.cfg, "lpt"), m = PM.propose(p, S.cfg, "min_move"); const iss = new Set(); l.changes.forEach((c) => c.sheets.forEach((s) => s.issued && iss.add(s.id))); return `A fresh-layout rebalance (LPT) reaches ${pct(l.afterImb)} too, but renumbers ${plural(l.changes.length, "circuit")} and touches tags on ${plural(iss.size, "issued sheet")}. Minimum moves gets there with ${plural(m.changes.length, "circuit")}.`; } },
    { title: "Respect the engineer's locks", step: 3,
      run(fast) {
        const p = panel(LP); S.sel = LP; S.view = "workspace";
        const c = p.circuits.find((x) => x.name === "Receptacles – Bay 3");
        c.doNotMove = true; modelChanged(p); propose(p, "min_move");
        activity(`${p.name}: circuit ${c.slot} "${c.name}" flagged DoNotMove`);
        if (fast) { S.boardMode = "proposed"; return null; }
        S.boardMode = "drawn"; S.anim.trace = true; return () => setTimeout(() => switchBoard("proposed"), 900);
      },
      caption: () => { const pr = panel(LP).proposal; const [a, b] = pr.changes; return `“Receptacles – Bay 3” is now flagged DoNotMove. The copilot works around it: it swaps “${a.name}” and “${b.name}” instead and still reaches ${pct(pr.afterImb)}. Two circuits are renumbered rather than one.`; } },
    { title: "Balance every flagged panel", step: 3,
      run() {
        const p = panel(LP); const c = p.circuits.find((x) => x.name === "Receptacles – Bay 3"); c.doNotMove = false; modelChanged(p);
        activity(`${p.name}: DoNotMove released on circuit ${c.slot}`);
        balanceAllFlagged(); S.view = "audit";
      },
      caption: () => { const ps = S.panels.filter((p) => p.proposal); const ok = ps.filter((p) => p.proposal.status === "proposed"); const other = ps.filter((p) => ["needs", "locked"].includes(p.proposal.status)); return `Batch run on ${plural(ps.length, "flagged panel")}: ${ok.length} proposals meet ${S.cfg.target}%. ${other.map((p) => p.proposal.status === "locked" ? `${p.name} is held back by its locks` : `${p.name} needs an engineer`).join("; ")}${other.length ? ". Each flag carries a reason the engineer can act on." : ""}`; } },
    { title: "Engineer review", step: 4,
      run() { S.panels.filter((p) => p.proposal && p.proposal.status === "proposed" && !p.review).forEach((p) => review(p, "accepted")); S.view = "audit"; },
      caption: () => `The engineer accepts or rejects each proposal, or re-runs it with a different target. Here all ${S.panels.filter((p) => p.review === "accepted").length} are accepted for the demo. Nothing has touched the model yet.` },
    { title: "Apply and read back", step: 5,
      run() { applyAccepted(); S.view = "audit"; },
      caption: () => { const t = S.tx.filter((x) => !x.undone); return `Accepted proposals are written back as named, undoable transactions: ${plural(t.reduce((s, x) => s + x.changes, 0), "circuit")} renumbered across ${plural(t.length, "panel")}. Each panel's phase loads are read back and must match the prediction within ±1 VA.`; } },
    { title: "Report and log", step: 5,
      run() { S.view = "report"; },
      caption: () => { const within = S.panels.filter((p) => live(p).imb <= S.cfg.target).length; return `Every decision is logged with before and after phase loads for the QA record. ${within} of ${S.panels.length} panels are now within ${S.cfg.target}%; the others carry a reason for the engineer.`; } },
  ];

  function goScene(i) {
    i = Math.max(0, Math.min(SCENES.length - 1, i));
    clearTimeout(S.tour.timer);
    S.tour.on = true; S.tour.i = i;
    resetProject(); S.cfg = clone(PM.DEFAULT_CONFIG);
    for (let k = 0; k < i; k++) SCENES[k].run(true);
    S.anim = {};
    const post = SCENES[i].run(false);
    render();
    window.scrollTo(0, 0);
    if (typeof post === "function") post();
    scheduleAuto();
  }
  function scheduleAuto() {
    clearTimeout(S.tour.timer);
    if (S.tour.on && S.tour.auto && S.tour.i < SCENES.length - 1) S.tour.timer = setTimeout(() => goScene(S.tour.i + 1), 10000);
    else if (S.tour.auto && S.tour.i >= SCENES.length - 1) { S.tour.auto = false; }
  }
  function endTour() { clearTimeout(S.tour.timer); S.tour.on = false; S.tour.auto = false; render(); }

  function viewPresenter() {
    const sc = SCENES[S.tour.i];
    let cap = "";
    try { cap = sc.caption(); } catch (e) { cap = ""; }
    return `<div class="pz">
      <div class="pz-progress">${SCENES.map((s, k) => `<button class="${k < S.tour.i ? "done" : k === S.tour.i ? "now" : ""}" data-act="scene" data-id="${k}" aria-label="Scene ${k + 1}: ${esc(s.title)}"></button>`).join("")}</div>
      <div>
        <div class="pz-step">Scene ${S.tour.i + 1} of ${SCENES.length} · Step ${sc.step} ${STEPS[sc.step - 1]}</div>
        <h3 class="pz-title">${esc(sc.title)}</h3>
        <p class="pz-caption">${esc(cap)}</p>
      </div>
      <div class="pz-ctl">
        <button class="btn" data-act="scene-prev" ${S.tour.i === 0 ? "disabled" : ""}>${icon("prev")} Back</button>
        <button class="btn btn-primary" id="pz-next" data-act="scene-next" ${S.tour.i === SCENES.length - 1 ? "disabled" : ""}>Next ${icon("next")}</button>
        <button class="btn" data-act="scene-auto" aria-pressed="${S.tour.auto}">${icon(S.tour.auto ? "pause" : "play")} ${S.tour.auto ? "Pause" : "Auto-play"}</button>
        <button class="btn" data-act="tour-end">Explore freely</button>
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
    const p = panel(S.sel);
    const memo = vizMemo(p);
    // phase bars
    const bars = $$(".pl-bar[data-w]");
    if (bars.length) { void bars[0].offsetWidth; requestAnimationFrame(() => bars.forEach((b) => { b.style.width = b.dataset.w; })); }
    memo.bars = memo.barsNext;
    // big imbalance number
    const big = $(".imb-big[data-tween-to]");
    if (big) {
      const from = parseFloat(big.dataset.tweenFrom), to = parseFloat(big.dataset.tweenTo);
      memo.imb = to;
      tween(from, to, 900, (v) => { big.textContent = pct(v); });
    }
    // phasor
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

  // ---------------------------------------------------------------- events
  const ACTIONS = {
    "view": (id) => { S.view = id; render(); $("#main").focus({ preventScroll: true }); },
    "open-panel": (id) => { openPanel(id); render(); window.scrollTo({ top: 0, behavior: reduced() ? "auto" : "smooth" }); },
    "run-audit": () => { runAudit(true); S.view = "audit"; render(); },
    "balance-all": () => { const f = balanceAllFlagged(); render(); toast(`Proposals generated for ${plural(f.length, "panel")}. Review them in the table.`); },
    "apply-accepted": () => { const n = applyAccepted(); render(); toast(`${plural(n, "transaction")} committed. Undo is available in Report & log.`); },
    "accept": (id) => { review(panel(id), "accepted"); render(); },
    "reject": (id) => { review(panel(id), "rejected"); render(); },
    "unreview": (id) => { panel(id).review = null; render(); },
    "apply": (id) => { const p = panel(id); if (apply(p)) { S.boardMode = "drawn"; render(); toast(`Applied as “Phase Balancer – ${p.name}”.`); } else render(); },
    "undo": (id) => { undo(id); S.boardMode = "drawn"; render(); toast("Transaction undone. The original layout is back."); },
    "sort": (key) => { S.sort = { key, dir: S.sort.key === key ? -S.sort.dir : key === "name" || key === "level" ? 1 : -1 }; render(); },
    "approach": (id) => { S.cfg.approach = id; const p = panel(S.sel); if (p.proposal && p.review !== "applied") runCopilot(p); else render(); },
    "basis": (id) => { S.cfg.basis = id; configChanged(); render(); },
    "run-copilot": () => runCopilot(panel(S.sel)),
    "design-change": () => { const r = simulateDesignChange(panel(S.sel)); render(); if (r) toast(`${r.ch.kind}: circuit ${r.c.slot} is now ${fmt(r.c.va)} VA. Re-run the audit to see the drift flagged.`); },
    "board-mode": (id) => { if (id === S.boardMode) return; switchBoard(id); },
    "board-style": (id) => { S.boardStyle = id; render(); },
    "pick-circuit": (id) => { S.selCircuit = S.selCircuit === id ? null : id; render(); },
    "close-insp": () => { S.selCircuit = null; render(); },
    "toggle-lock": (id) => { const p = panel(S.sel); const re = toggleLock(p, id); if (re && p.proposal.changes.length) { S.anim.trace = true; S.boardMode = "drawn"; render(); setTimeout(() => switchBoard("proposed"), reduced() ? 0 : 450); } else render(); },
    "focus-target": () => { const el = $("#target"); if (el) { el.focus(); el.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" }); toast("Adjust the target, then press Run copilot."); } },
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
      const fallback = () => { const pre = $("#csv-pre"); if (pre) { const r = document.createRange(); r.selectNodeContents(pre); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); } toast("Copying is blocked here. The CSV text is selected, so press Ctrl+C or ⌘C."); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast(`CSV copied: ${plural(S.log.length, "row")}.`), fallback);
      else fallback();
    },
    "run-tests": () => { S.tests = runSelfTests(); render(); const f = S.tests.filter((t) => !t.pass).length; toast(f ? `${f} of 9 tests failed.` : "All 9 tests pass."); },
    "reset": () => { resetProject(); S.view = "audit"; S.tour.on = false; render(); toast("Sample model restored to its drawn state."); },
    "theme": () => setTheme(),
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
    if (id.startsWith("as-")) { const st = store.get("pbc-assumptions") || {}; st[id.slice(3)] = el.checked; store.set("pbc-assumptions", st); return; }
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
  if (hp.get("scene")) {
    goScene((+hp.get("scene") || 1) - 1);
    if (hp.get("presenter") === "off") { S.tour.on = false; }
  }
  if (hp.get("panel")) S.sel = hp.get("panel");
  if (hp.get("view")) S.view = hp.get("view");
  if (hp.get("mode")) S.boardMode = hp.get("mode");
  if (hp.get("style")) S.boardStyle = hp.get("style");
  if (hp.get("tests")) S.tests = runSelfTests();
  render();
  if (S.dl === "pending") {
    window.claude.use("downloads").then((d) => { S.dlNs = d; S.dl = d ? "ok" : "none"; if (S.view === "report") render(); }, () => { S.dl = "none"; if (S.view === "report") render(); });
  }
  window.__pbc = { S, render, goScene };
})();
