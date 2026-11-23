import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  barredByPlan,
  compulsoryYears,
  liftRouteCommonCourses,
  pickerHideReason,
  regulationGroups,
  regulationsId,
  routeCommonCodes,
  type RegulationsFile,
} from "./builderRules";
import { allocateSlots, slotKey } from "./degreeLogic";
import type { Plan } from "./planStore";
import type { Programme } from "./programmes";
import { allowedTermSlots, slotOf } from "./plannerLogic";
import type { Course, IndexEntry } from "./types";

const dataDir = path.join(__dirname, "..", "..", "public", "data");
const raw = JSON.parse(readFileSync(path.join(dataDir, "programmes.json"), "utf8")) as Programme[];
const regsFor = (name: string): RegulationsFile => {
  const index = JSON.parse(readFileSync(path.join(dataDir, "programmes", "index.json"), "utf8")) as { id: string }[];
  const id = index.find((e) => e.id.toLowerCase() === regulationsId(name).toLowerCase())!.id;
  return JSON.parse(readFileSync(path.join(dataDir, "programmes", `${id}.json`), "utf8"));
};
/** As the app loads it: courses upper-cased and route-common courses lifted out. */
const load = (name: string): Programme => {
  const p = raw.find((x) => x.name === name)!;
  return { ...p, crossYearRules: [], years: p.years.map((y) => liftRouteCommonCourses(y)) };
};

const entry = (code: string, units: number): IndexEntry =>
  ({ code, title: code, department: null, units, terms: ["AT"], courseLevel: 1 }) as unknown as IndexEntry;

describe("courses in every route are compulsory", () => {
  it("finds EC1B1 in both of BSc Economics' Year 1 routes", () => {
    const y1 = raw.find((p) => p.name === "BSc Economics")!.years[0];
    expect(routeCommonCodes(y1)).toEqual(["EC1B1"]);
  });

  it("turns Paper 3 into a straight MA108 or MA100 choice, with EC1B1 compulsory", () => {
    const y1 = load("BSc Economics").years[0];
    const lifted = y1.slots.find((s) => s.ruleType === "compulsory" && s.courses.includes("EC1B1"))!;
    expect(lifted.units).toBe(0.5);
    const paper3 = y1.slots.find((s) => s.ruleType === "choose_one_of")!;
    expect(paper3.routes!.map((r) => [r.label, r.courses, r.units])).toEqual([
      ["MA108", ["MA108"], 0.5],
      ["MA100", ["MA100"], 1],
    ]);
    const paper4 = y1.slots.find((s) => s.ruleType === "outside_option")!;
    expect(paper4.routes!.map((r) => [r.label, r.units])).toEqual([
      ["If Paper 3 was MA108", 1],
      ["If Paper 3 was MA100", 0.5],
    ]);
  });

  it("applies to BSc Econometrics and Mathematical Economics too, and leaves other degrees' courses intact", () => {
    expect(routeCommonCodes(raw.find((p) => p.name === "BSc Econometrics and Mathematical Economics")!.years[0])).toEqual([
      "EC1B1",
    ]);
    for (const p of raw) {
      for (const y of p.years) {
        const before = new Set(y.slots.flatMap((s) => [...s.courses, ...(s.routes ?? []).flatMap((r) => r.courses)]));
        const after = new Set(
          liftRouteCommonCourses(y).slots.flatMap((s) => [...s.courses, ...(s.routes ?? []).flatMap((r) => r.courses)]),
        );
        expect([...before].every((c) => after.has(c))).toBe(true);
      }
    }
  });

  it("sets Paper 4's unit target from the chosen route", () => {
    const prog = load("BSc Economics");
    const byCode = new Map(
      [["EC1P1", 0.5], ["EC1A1", 0.5], ["ST109", 0.5], ["EC1C1", 0.5], ["EC1B1", 0.5], ["MA108", 0.5], ["MA100", 1], ["LSE100", 0.5]].map(
        ([c, u]) => [c as string, entry(c as string, u as number)],
      ),
    );
    const y1 = prog.years[0];
    const p4 = y1.slots.find((s) => s.ruleType === "outside_option")!;
    const plan = (maths: string): Plan =>
      ({ years: 3, exemptions: [], items: ["EC1P1", "EC1A1", "ST109", "EC1C1", "EC1B1", maths].map((code) => ({ code, year: 1 })) }) as Plan;
    expect(allocateSlots(prog, plan("MA108"), byCode, new Map()).get(slotKey(1, p4.order))!.target).toBe(1);
    expect(allocateSlots(prog, plan("MA100"), byCode, new Map()).get(slotKey(1, p4.order))!.target).toBe(0.5);
  });
});

describe("options that can't be taken are hidden", () => {
  const details = new Map<string, Course | null>([
    ["MA108", { code: "MA108", preclusions: [{ code: "MA107" }, { code: "MA100" }] } as unknown as Course],
    ["ST109", { code: "ST109", preclusions: [{ code: "ST107" }, { code: "ST102" }] } as unknown as Course],
  ]);
  const barred = barredByPlan(details, ["MA108", "ST109"]);
  const ctx = { barred, ownPrefixes: new Set(["EC"]) };

  it("hides courses barred alongside the plan, with the reason", () => {
    expect(barred.get("MA107")).toBe("Can’t be taken with MA108");
    expect(barred.get("ST107")).toBe("Can’t be taken with ST109");
    expect(pickerHideReason("MA107", ctx, { outsideOption: true, alreadyHere: false })).toBe("Can’t be taken with MA108");
  });

  it("hides own-department courses only from outside options", () => {
    expect(pickerHideReason("EC2A3", ctx, { outsideOption: true, alreadyHere: false })).toMatch(/own department/);
    expect(pickerHideReason("EC313", ctx, { outsideOption: false, alreadyHere: false })).toBeNull();
    expect(pickerHideReason("GY209", ctx, { outsideOption: true, alreadyHere: false })).toBeNull();
  });

  it("never hides a course already counted, so it can still be removed", () => {
    expect(pickerHideReason("MA107", ctx, { outsideOption: true, alreadyHere: true })).toBeNull();
  });
});

describe("pickers split into the regulations' named lists", () => {
  it("BSc Economics Year 3: the two selection lists, other approved courses, then exceptional outside options", () => {
    const groups = regulationGroups(regsFor("BSc Economics"), 3);
    expect(groups.map((g) => [g.name, g.outside])).toEqual([
      ["Economics Selection List", null],
      ["Additional Selection List", null],
      ["Other approved courses", null],
      ["Undergraduate Outside Options List (Years 2 & 3)", "exceptional"],
    ]);
    expect(groups[0].codes.size).toBe(17);
  });

  it("BSc Economics Year 1: the Year 1 outside options list is an ordinary choice, and plain choices get no section", () => {
    const groups = regulationGroups(regsFor("BSc Economics"), 1);
    expect(groups.find((g) => g.outside)?.name).toBe("Undergraduate Outside Options List (Year 1)");
    expect(groups.find((g) => g.outside)?.outside).toBe("allowed");
    const named = groups.find((g) => g.name === "Other approved courses");
    expect([...(named?.codes ?? [])].some((c) => ["MA108", "MA100", "LSE100A"].includes(c))).toBe(false);
  });

  it("finds a regulations file for every degree except the LLB", () => {
    const index = new Set(
      (JSON.parse(readFileSync(path.join(dataDir, "programmes", "index.json"), "utf8")) as { id: string }[]).map((e) =>
        e.id.toLowerCase(),
      ),
    );
    const missing = raw.filter((p) => !index.has(regulationsId(p.name).toLowerCase())).map((p) => p.name);
    expect(missing).toEqual(["LLB Bachelor of Laws"]);
  });
});

describe("compulsory courses and BSc Economics Year 3", () => {
  it("knows which year each compulsory course belongs to, including EC1B1 and LSE100", () => {
    const years = compulsoryYears(load("BSc Economics"));
    expect(years.get("EC1B1")).toBe(1);
    expect(years.get("EC2A1")).toBe(2);
    expect(years.get("LSE100")).toBe(1);
    expect(years.has("MA108")).toBe(false);
  });

  it("has Year 2 Paper 8 as either Finance (FM214 + FM215) or other courses from the outside options list", () => {
    const y2 = raw.find((p) => p.name === "BSc Economics")!.years.find((y) => y.year === 2)!;
    const paper8 = y2.slots.find((s) => s.text.startsWith("Paper 8"))!;
    expect(paper8.units).toBe(1);
    expect(paper8.either?.map((o) => [o.id, o.bundle ?? false, o.courses ?? o.lists])).toEqual([
      ["finance", true, ["FM214", "FM215"]],
      ["other", false, ["Undergraduate Outside Options List (Years 2 & 3)"]],
    ]);
    expect(paper8.courses).toEqual(expect.arrayContaining(["FM214", "FM215", "AC102", "MG207"]));
    expect(paper8.courses).not.toContain("EH238"); // suspended in 2026/27
    expect(y2.slots.find((s) => s.ruleType === "compulsory")!.courses).toEqual(["EC2A1", "EC2B1", "EC2C1"]);
    const groups = regulationGroups(regsFor("BSc Economics"), 2);
    expect(groups.map((g) => [g.name, g.outside])).toEqual([
      ["Other approved courses", null],
      ["Undergraduate Outside Options List (Years 2 & 3)", "allowed"],
    ]);
  });

  it("has Year 3 as one choice per paper (Papers 9 & 10 split), with outside options only in Paper 12", () => {
    const y3 = raw.find((p) => p.name === "BSc Economics")!.years.find((y) => y.year === 3)!;
    expect(y3.slots.map((s) => [s.text.split(":")[0], s.units])).toEqual([
      ["Paper 9", 1],
      ["Paper 10", 1],
      ["Paper 11", 1],
      ["Paper 12", 1],
    ]);
    const regs = regsFor("BSc Economics");
    const esl = new Set(regs.lists["Economics Selection List"]);
    expect(y3.slots[0].courses.every((c) => esl.has(c))).toBe(true);
    expect(y3.slots[1].courses).toEqual(y3.slots[0].courses);
    const outsideOnly = regs.lists["Undergraduate Outside Options List (Years 2 & 3)"].filter(
      (c) => !esl.has(c) && !regs.lists["Additional Section List"].includes(c),
    );
    expect(y3.slots.slice(0, 3).some((s) => s.courses.some((c) => outsideOnly.includes(c)))).toBe(false);
    expect(outsideOnly.every((c) => y3.slots[3].courses.includes(c))).toBe(true);
  });
});

describe("courses stay in the terms they're taught in", () => {
  const e = (terms: string[], units: number) => ({ code: "X", terms, units }) as unknown as IndexEntry;
  const index = JSON.parse(readFileSync(path.join(dataDir, "index.json"), "utf8")) as IndexEntry[];
  const real = (code: string) => index.find((c) => c.code === code)!;

  it("gives every course with term data exactly one placement", () => {
    expect(allowedTermSlots(e(["AT"], 0.5))).toEqual(["AT"]);
    expect(allowedTermSlots(e(["WT"], 0.5))).toEqual(["WS"]);
    expect(allowedTermSlots(e(["WT", "ST"], 0.5))).toEqual(["WS"]);
    expect(allowedTermSlots(e(["AT", "WT", "ST"], 1))).toEqual(["BOTH"]);
    expect(allowedTermSlots(e([], 0.5))).toBeNull(); // no term data: still free to place
    for (const c of index) {
      const a = allowedTermSlots(c);
      if (a) expect(a).toHaveLength(1);
    }
  });

  it("places the real two-term half units by how they run", () => {
    // run across Autumn and Winter
    for (const code of ["LSE100", "MA334", "GY360"]) expect(allowedTermSlots(real(code))).toEqual(["BOTH"]);
    // taught in Autumn, listed in Spring for revision/exams
    for (const code of ["MA203", "PH333", "ST307"]) expect(allowedTermSlots(real(code))).toEqual(["AT"]);
  });

  it("ignores a saved term the course isn't taught in", () => {
    const byCode = new Map([["AC102", { code: "AC102", terms: ["AT"], units: 0.5 } as unknown as IndexEntry]]);
    expect(slotOf({ code: "AC102", year: 1, slot: "WS" }, byCode)).toBe("AT");
    expect(slotOf({ code: "AC102", year: 1, slot: "AT" }, byCode)).toBe("AT");
  });
});

/* ---------- prerequisites shown on options ---------- */
import { parsePrerequisites } from "./prereqText";
import { departmentGroups, optionPrereqStatus } from "./builderRules";
import type { CourseMeta } from "./coursesData";

describe("prerequisite wording becomes a tree", () => {
  it("reads LSE's bracketed wording", () => {
    expect(parsePrerequisites("Before taking this course, students must have completed: EC1A1 and (MA100 or MA108).")).toEqual({
      type: "and",
      children: [
        { type: "course", code: "EC1A1" },
        { type: "or", children: [{ type: "course", code: "MA100" }, { type: "course", code: "MA108" }] },
      ],
    });
  });
  it("ignores exclusions and wording without course codes", () => {
    expect(parsePrerequisites("Students must not have taken ST109 before this course.")).toBeNull();
    expect(parsePrerequisites("A-level Mathematics or equivalent.")).toBeNull();
  });
});

describe("each option shows whether its prerequisites would be met", () => {
  const meta = (code: string, prerequisites: string): CourseMeta => ({ code, prerequisites }) as unknown as CourseMeta;
  const courseMeta = new Map<string, CourseMeta>([
    ["EC2A1", meta("EC2A1", "Before taking this course, students must have completed: EC1A1 and (MA100 or MA108).")],
    ["EC2C3", meta("EC2C3", "Before taking this course, students must have completed: (ST107 and MA107) or (ST102 and MA100).")],
    ["XX201", meta("XX201", "Students must have completed EC1A1 before taking this course.")],
  ]);
  const ix = (code: string, terms: string[], units = 0.5) => [code, { code, terms, units } as unknown as IndexEntry] as const;
  const byCode = new Map([ix("EC1A1", ["AT"]), ix("MA108", ["AT"]), ix("EC2A1", ["AT"]), ix("EC2C3", ["AT"]), ix("XX201", ["WT"]), ix("ST109", ["AT"]), ix("ST110", ["WT"]), ix("MA108", ["AT"])]);
  const plan = (items: [string, number][], exemptions: string[] = []): Plan =>
    ({ years: 3, exemptions, items: items.map(([code, year]) => ({ code, year })) }) as Plan;

  it("met, and not met with what's missing", () => {
    expect(optionPrereqStatus("EC2A1", 2, plan([["EC1A1", 1], ["MA108", 1]]), byCode, courseMeta)?.met).toBe(true);
    const s = optionPrereqStatus("EC2A1", 2, plan([["EC1A1", 1]]), byCode, courseMeta)!;
    expect(s.met).toBe(false);
    expect(s.needs).toBe("Needs one of MA100, MA108");
  });

  it("counts an Autumn course for a Winter course in the same year, but not the same term", () => {
    expect(optionPrereqStatus("XX201", 1, plan([["EC1A1", 1]]), byCode, courseMeta)?.met).toBe(true);
    expect(optionPrereqStatus("EC2A1", 1, plan([["EC1A1", 1], ["MA108", 1]]), byCode, courseMeta)?.met).toBe(false);
  });

  it("uses the equivalence rules and says so", () => {
    // ST109 + ST110 = ST102 → covers ST107; MA108 covers MA107
    const s = optionPrereqStatus("EC2C3", 2, plan([["ST109", 1], ["ST110", 1], ["MA108", 1]]), byCode, courseMeta)!;
    expect(s.met).toBe(true);
    expect(s.via).toMatch(/MA108 as covering MA107/);
    expect(s.via).toMatch(/ST102 as covering ST107/);
  });

  it("names only what's still missing in each alternative", () => {
    const m = new Map(courseMeta);
    m.set("EC317", meta("EC317", "Before taking this course, students must have completed: EC2C1 or (EC2C3 and EC2C4)."));
    const s = optionPrereqStatus("EC317", 3, plan([["EC2C3", 2]]), byCode, m)!;
    expect(s.needs).toBe("Needs one of EC2C1, EC2C4");
  });

  it("counts exemptions, and gives null when no prerequisites are listed", () => {
    expect(optionPrereqStatus("XX201", 1, plan([], ["EC1A1"]), byCode, courseMeta)?.met).toBe(true);
    expect(optionPrereqStatus("ZZ100", 1, plan([]), byCode, courseMeta)).toBeNull();
  });
});

describe("sub-lists by department when the regulations name none", () => {
  it("puts the degree's own departments first and merges the smallest", () => {
    const opts = [
      ...["GV1", "GV2", "GV3"].map((c) => ({ code: `${c}00`, department: "Government" })),
      ...["EC1", "EC2"].map((c) => ({ code: `${c}00`, department: "Economics" })),
      { code: "PH100", department: "Philosophy" },
      { code: "AN100", department: "Anthropology" },
      { code: "SO100", department: "Sociology" },
    ];
    const groups = departmentGroups(opts, new Set(["PH", "EC"]), 4);
    expect(groups.map((g) => [g.name, g.codes.size])).toEqual([
      ["Economics", 2],
      ["Philosophy", 1],
      ["Government", 3],
      ["Other departments", 2],
    ]);
  });
});

describe("BSc PPE follows its regulations", () => {
  const ppe = () => raw.find((p) => p.name === "BSc Philosophy, Politics and Economics")!;
  it("Year 3: Papers 9-11 have their lists, and the year adds up to 4 units", () => {
    const y3 = ppe().years.find((y) => y.year === 3)!;
    expect(y3.slots.map((s) => [s.text.match(/^Paper \d+/)?.[0] ?? s.ruleType, s.units])).toEqual([
      ["compulsory", 0.5],
      ["Paper 9", 1],
      ["Paper 10", 0.5],
      ["Paper 11", 1],
      ["choose_one_of", 1],
    ]);
    expect(y3.slots[2].courses).not.toContain("PH344"); // the compulsory half of Paper 10
  });
  it("Year 4: Paper 15 from the subject lists, Paper 16 also from outside options", () => {
    const y4 = ppe().years.find((y) => y.year === 4)!;
    const [p15, p16] = y4.slots.filter((s) => /^Paper 1[56]/.test(s.text));
    expect([p15.units, p16.units]).toEqual([1, 1]);
    expect(p16.courses.length).toBeGreaterThan(p15.courses.length);
    const regs = regsFor("BSc Philosophy, Politics and Economics");
    expect(regulationGroups(regs, 4).map((g) => [g.name, g.outside])).toEqual([
      ["Philosophy Options List", null],
      ["Economics Options List", null],
      ["Government List B", null],
      ["Undergraduate Outside Options List (Years 2 & 3)", "allowed"],
    ]);
  });
});
