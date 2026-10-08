/*
 * Sample pilot model: 12 three-phase four-wire panelboards across five levels.
 * Fictional data for the dry run. Each panel exercises one behaviour from the test plan (§15).
 * LP-2A reproduces the worked example in §9 exactly.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SampleProject = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SHEETS = {
    "E-211": { id: "E-211", title: "Level 01 small power", issued: false, rev: "P02" },
    "E-311": { id: "E-311", title: "Level 01 lighting", issued: false, rev: "P02" },
    "E-221": { id: "E-221", title: "Level 02 small power", issued: true, rev: "P03" },
    "E-321": { id: "E-321", title: "Level 02 lighting", issued: true, rev: "P03" },
    "E-231": { id: "E-231", title: "Level 03 small power", issued: true, rev: "P03" },
    "E-331": { id: "E-331", title: "Level 03 lighting", issued: false, rev: "P02" },
    "E-241": { id: "E-241", title: "Level 04 small power", issued: false, rev: "P01" },
    "E-341": { id: "E-341", title: "Level 04 lighting", issued: false, rev: "P01" },
    "E-251": { id: "E-251", title: "Roof plant power", issued: false, rev: "P01" },
    "E-601": { id: "E-601", title: "Schematic and panel schedules", issued: true, rev: "P03" },
  };

  const LEVEL_CODE = { "Level 01": "1", "Level 02": "2", "Level 03": "3", "Level 04": "4", "Roof": "5" };

  function sheetsFor(level, cls) {
    const n = LEVEL_CODE[level];
    const plan = cls === "LTG" ? `E-3${n}1` : `E-2${n}1`;
    return [SHEETS[plan] || SHEETS[`E-2${n}1`], SHEETS["E-601"]].filter(Boolean);
  }

  // c(slot, va, name, cls, extra)  — 1-pole unless extra.poles says otherwise
  function c(slot, va, name, cls, extra) {
    return Object.assign({ slot, va, name, cls, poles: 1 }, extra || {});
  }
  const spare = (slot) => ({ slot, va: 0, name: "Spare", cls: "REC", poles: 1, spare: true });

  const panels = [
    {
      name: "LP-1A", level: "Level 01", use: "Lighting", ways: 18, main: "63 A MCB", fedFrom: "MDB-01 · F-01",
      circuits: [
        c(1, 1600, "Lighting – Entrance lobby", "LTG"),
        c(3, 1500, "Lighting – Corridor L01", "LTG"),
        c(5, 1600, "Lighting – Reception", "LTG"),
        c(7, 900, "Emergency lighting L01", "LTG", { lockedSlot: true }),
        c(9, 1100, "Lighting – Toilets L01", "LTG"),
        c(11, 1200, "Façade lighting", "LTG"),
        c(13, 600, "Exit signs L01", "LTG", { lockedSlot: true }),
        c(15, 500, "Lighting – Stair 1", "LTG"),
        spare(17),
      ],
    },
    {
      name: "PP-1A", level: "Level 01", use: "Small power", ways: 30, main: "125 A MCCB", fedFrom: "MDB-01 · F-02",
      circuits: [
        c(1, 9000, "Lift 1 controller", "EQP", { poles: 3 }),
        c(2, 4000, "Water heater WH-01 (400 V)", "EQP", { poles: 2 }),
        c(6, 1800, "Receptacles – Retail unit 1", "REC"),
        c(7, 1500, "Receptacles – Lobby", "REC"),
        c(8, 1700, "Vending machines", "EQP"),
        c(9, 900, "Receptacles – Security desk", "REC"),
        c(10, 1600, "Receptacles – Retail unit 2", "REC"),
        c(11, 1200, "Hand dryers L01", "EQP"),
        spare(12),
        c(13, 1400, "Coffee point", "EQP"),
        spare(14),
        c(15, 600, "Receptacles – Cleaners store", "REC"),
        c(17, 1000, "Receptacles – Loading bay", "REC"),
        c(19, 800, "Roller shutter RS-1", "EQP"),
      ],
    },
    {
      name: "MP-1", level: "Level 01", use: "Mechanical", ways: 18, main: "160 A MCCB", fedFrom: "MDB-01 · F-03",
      circuits: [
        c(1, 7500, "Chilled water pump CHWP-1", "MECH", { poles: 3 }),
        c(2, 7500, "Chilled water pump CHWP-2", "MECH", { poles: 3 }),
        c(7, 5500, "Booster set BS-1", "MECH", { poles: 3 }),
        c(8, 3000, "Sump pump SP-1", "MECH", { poles: 3 }),
        c(13, 2200, "Sprinkler jockey pump", "MECH", { poles: 3 }),
      ],
    },
    {
      name: "LP-2A", level: "Level 02", use: "Lighting & receptacles", ways: 24, main: "63 A MCB", fedFrom: "MDB-01 · F-04",
      note: "Worked example from §9 of the concept document",
      noteDetail: "Nine circuits drawn in modelling order down the left-hand column, slots 1–17, so their phases rotate A, B, C. Circuit number equals slot number (§1.1).",
      circuits: [
        c(1, 2400, "Lighting – Open office east", "LTG"),
        c(3, 1800, "Lighting – Open office west", "LTG"),
        c(5, 1500, "Receptacles – Bay 1", "REC"),
        c(7, 1500, "Receptacles – Bay 2", "REC"),
        c(9, 1200, "Lighting – Meeting rooms", "LTG"),
        c(11, 1000, "Receptacles – Meeting rooms", "REC"),
        c(13, 900, "Receptacles – Bay 3", "REC"),
        c(15, 800, "Lighting – Corridor L02", "LTG"),
        c(17, 600, "Receptacles – Copy room", "REC"),
      ],
    },
    {
      name: "RP-2B", level: "Level 02", use: "Receptacles", ways: 18, main: "63 A MCB", fedFrom: "MDB-01 · F-05",
      note: "Every phase C slot is full, so the copilot can only swap onto C",
      circuits: [
        c(1, 1800, "Receptacles – Bay 4", "REC"),
        c(2, 1500, "Receptacles – Bay 5", "REC"),
        c(3, 1400, "Receptacles – Bay 7", "REC"),
        c(4, 1200, "Receptacles – Bay 8", "REC"),
        c(5, 600, "Floor boxes – Zone 1", "REC"),
        c(6, 650, "Floor boxes – Zone 2", "REC"),
        c(7, 1200, "Printer hub", "EQP"),
        c(8, 1000, "Receptacles – Bay 6", "REC"),
        c(9, 1500, "Receptacles – Pantry", "REC"),
        c(10, 600, "Water boiler", "EQP"),
        c(11, 700, "Floor boxes – Zone 3", "REC"),
        c(12, 900, "AV rack – Boardroom", "EQP"),
        c(17, 800, "Comms outlets L02", "REC"),
        c(18, 650, "Cleaner sockets L02", "REC"),
      ],
    },
    {
      name: "LP-2C", level: "Level 02", use: "Lighting", ways: 18, main: "40 A MCB", fedFrom: "MDB-01 · F-06",
      circuits: [
        c(1, 1400, "Lighting – Atrium", "LTG"),
        c(2, 300, "Exit signs L02", "LTG", { lockedSlot: true }),
        c(3, 1300, "Lighting – Lift lobby L02", "LTG"),
        c(5, 3000, "Atrium heater AH-1 (400 V)", "EQP", { poles: 2 }),
        c(9, 1100, "Lighting – Breakout", "LTG"),
        c(11, 900, "Lighting – Toilets L02", "LTG"),
        spare(13),
        c(15, 700, "Lighting – Stair 2", "LTG"),
        c(17, 600, "Feature lighting – Atrium", "LTG"),
      ],
    },
    {
      name: "LP-3C", level: "Level 03", use: "Lighting & receptacles", ways: 24, main: "63 A MCB", fedFrom: "MDB-01 · F-07",
      note: "Two circuits flagged DoNotMove; the copilot has to work around them",
      circuits: [
        c(1, 2200, "Lighting – Studio north", "LTG", { doNotMove: true }),
        c(2, 1600, "Receptacles – Studio north", "REC"),
        c(3, 900, "Lighting – Studio south", "LTG"),
        c(4, 1300, "Receptacles – Plotter room", "EQP"),
        c(5, 1200, "Receptacles – Quiet room", "REC"),
        c(6, 1000, "Lighting – Corridor L03", "LTG"),
        c(7, 1100, "Receptacles – Kitchenette L03", "EQP"),
        c(9, 1800, "Receptacles – Model shop", "REC", { doNotMove: true }),
        c(11, 800, "Lighting – Toilets L03", "LTG"),
        c(13, 600, "Lighting – Library", "LTG"),
        c(15, 500, "Exit signs L03", "LTG", { lockedSlot: true }),
        spare(17),
      ],
    },
    {
      name: "PP-3A", level: "Level 03", use: "Small power", ways: 18, main: "80 A MCCB", fedFrom: "MDB-01 · F-08",
      note: "One very large single-pole load dominates the panel",
      circuits: [
        c(1, 3700, "Server rack UPS – Comms room", "EQP"),
        c(3, 1400, "Receptacles – Comms room", "REC"),
        c(5, 1300, "Receptacles – Print room", "REC"),
        c(7, 700, "Receptacles – Store L03", "REC"),
        c(9, 600, "Hand dryers L03", "EQP"),
        c(11, 1200, "Receptacles – Riser cupboard", "REC"),
        c(13, 500, "Receptacles – Cleaners L03", "REC"),
        spare(15),
      ],
    },
    {
      name: "LP-3B", level: "Level 03", use: "Lighting", ways: 18, main: "40 A MCB", fedFrom: "MDB-01 · F-09",
      note: "One circuit has no load assigned in the model",
      circuits: [
        c(1, 1300, "Lighting – Open office L03", "LTG"),
        c(3, 1200, "Lighting – Meeting suite", "LTG"),
        c(5, 1250, "Lighting – Collaboration zone", "LTG"),
        c(7, 0, "Display lighting – Gallery", "LTG"),
        c(9, 300, "Lighting – Stair 3", "LTG"),
        c(11, 450, "Exit signs L03 east", "LTG", { lockedSlot: true }),
        c(13, 350, "Lighting – Plant room L03", "LTG"),
        spare(15),
      ],
    },
    {
      name: "LP-4A", level: "Level 04", use: "Lab lighting & power", ways: 18, main: "63 A MCB", fedFrom: "MDB-01 · F-10",
      note: "The heavy circuits are locked, so balance is limited by the locks",
      circuits: [
        c(1, 1500, "Fume cupboard controls", "EQP", { lockedSlot: true }),
        c(2, 600, "Lighting – Lab 1", "LTG"),
        c(3, 1100, "Lighting – Lab 2", "LTG"),
        c(5, 900, "Lighting – Prep room", "LTG"),
        c(7, 1000, "Lab benches – Row 2", "REC", { doNotMove: true }),
        c(9, 500, "Exit signs L04", "LTG"),
        c(11, 700, "Lighting – Lab corridor", "LTG"),
      ],
    },
    {
      name: "LP-4B", level: "Level 04", use: "Lighting & receptacles", ways: 18, main: "63 A MCB", fedFrom: "MDB-01 · F-11",
      circuits: [
        c(1, 1500, "Lighting – Workspace L04", "LTG"),
        c(3, 1400, "Lighting – Meeting rooms L04", "LTG"),
        c(5, 1100, "Lighting – Corridor L04", "LTG"),
        c(7, 1200, "Receptacles – Hot desks", "REC"),
        c(9, 1300, "Receptacles – Meeting rooms L04", "REC"),
        c(11, 1100, "Receptacles – Kitchenette L04", "EQP"),
        c(13, 700, "Receptacles – Phone booths", "REC"),
        spare(15),
        c(17, 600, "Receptacles – Reprographics", "REC"),
      ],
    },
    {
      name: "PP-R1", level: "Roof", use: "Plant power", ways: 24, main: "200 A MCCB", fedFrom: "MDB-01 · F-12",
      circuits: [
        c(1, 18000, "Air handling unit AHU-1", "MECH", { poles: 3 }),
        c(2, 11000, "Condensing unit CU-1", "MECH", { poles: 3 }),
        c(7, 3200, "Kitchen extract fan KEF-1 (400 V)", "MECH", { poles: 2 }),
        c(8, 1200, "Roof lighting & beacons", "LTG"),
        c(10, 900, "Plant room receptacles", "REC"),
        c(11, 1200, "BMS panel – Roof", "EQP"),
        c(12, 1100, "Trace heating – Roof", "EQP"),
        c(13, 1400, "Façade maintenance unit", "EQP"),
        spare(14),
        c(16, 800, "Lift motor room lighting", "LTG"),
      ],
    },
  ];

  function build() {
    return panels.map((p, i) => ({
      id: p.name,
      name: p.name, level: p.level, use: p.use, ways: p.ways, main: p.main, fedFrom: p.fedFrom, note: p.note || "", noteDetail: p.noteDetail || "",
      circuits: p.circuits.map((cc, k) => Object.assign({ id: `${p.name}#${k}`, lockedSlot: false, doNotMove: false, spare: false },
        cc, { sheets: cc.spare ? [] : sheetsFor(p.level, cc.cls) })),
    }));
  }

  return {
    project: { number: "PRJ-2471", name: "Sample office and lab building", stage: "RIBA Stage 4 · Technical design" },
    levels: ["Roof", "Level 04", "Level 03", "Level 02", "Level 01"],
    sheets: SHEETS,
    build,
  };
});
