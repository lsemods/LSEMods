/**
 * Pure rules behind the course builder's requirement pickers.
 *
 * 1. liftRouteCommonCourses — a course that is part of every route of a year's choice is compulsory
 *    (e.g. BSc Economics Year 1: EC1B1 is in both the MA108 route and the MA100 route), so it becomes its
 *    own locked compulsory slot and the choice is just "MA108 or MA100".
 * 2. pickerHideReason — options a student can't usefully pick: courses LSE bars alongside something
 *    already planned, and own-department courses offered as "outside" options.
 * 3. regulationGroups — split a picker into the named lists from the official regulations
 *    ("Economics Selection List", "Additional Selection List", outside options, …).
 * 4. compulsoryYears — which year each compulsory course belongs to (used to lock the year board).
 */
import { canonicalCode, codeAliases } from "./courseAliases";
import type { Programme, ProgrammeSlot, ProgrammeYear } from "./programmes";
import type { Course } from "./types";

/* ---------- 1. Courses in every route are compulsory ---------- */

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Codes that appear in every route id of the year (routes with the same id are linked across slots). */
export function routeCommonCodes(year: ProgrammeYear): string[] {
  const byRoute = new Map<string, Set<string>>();
  for (const s of year.slots) {
    for (const r of s.routes ?? []) {
      const set = byRoute.get(r.id) ?? new Set<string>();
      for (const c of r.courses) set.add(canonicalCode(c));
      byRoute.set(r.id, set);
    }
  }
  if (byRoute.size < 2) return [];
  const [first, ...rest] = [...byRoute.values()];
  return [...first].filter((c) => rest.every((s) => s.has(c))).sort();
}

/** A course's unit value as written in the year's own text, e.g. "EC1B1 Macroeconomics I (0.5)". */
function unitsInText(year: ProgrammeYear, code: string): number | null {
  const re = new RegExp(`${esc(code)}[^()]*\\((\\d+(?:\\.\\d+)?)\\)`, "i");
  for (const s of year.slots) {
    for (const t of [s.text, ...(s.routes ?? []).map((r) => r.text ?? "")]) {
      const m = t?.match(re);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

const dropFromLabel = (label: string, code: string) =>
  label
    .replace(new RegExp(`\\s*\\+\\s*${esc(code)}\\b`, "g"), "")
    .replace(new RegExp(`\\b${esc(code)}\\s*\\+\\s*`, "g"), "")
    .trim();

function dropFromText(text: string, code: string): string {
  const out = text
    // "MA108 (0.5) and EC1B1 (0.5)"  →  "MA108 (0.5)"
    .replace(new RegExp(`\\s*(?:,|and|\\+|plus)\\s*${esc(code)}[^()]*\\(\\d+(?:\\.\\d+)?\\)`, "gi"), "")
    // "EC1B1 Macroeconomics I (0.5) plus a 0.5 unit …"  →  "a 0.5 unit …"
    .replace(new RegExp(`^\\s*${esc(code)}[^()]*\\(\\d+(?:\\.\\d+)?\\)\\s*(?:,|and|\\+|plus)?\\s*`, "i"), "")
    .trim();
  return out ? out[0].toUpperCase() + out.slice(1) : out;
}

/**
 * Move courses that every route includes out of the routes and into a compulsory slot of their own.
 * Route unit targets drop by those courses' units, so e.g. Paper 4 needs 1.0 unit after MA108 but 0.5 after MA100.
 * Years without shared route courses (or whose units can't be read) are returned unchanged.
 */
export function liftRouteCommonCourses(year: ProgrammeYear): ProgrammeYear {
  const common = routeCommonCodes(year).filter((c) => unitsInText(year, c) != null);
  if (common.length === 0) return year;
  const unitsOf = new Map(common.map((c) => [c, unitsInText(year, c)!] as const));
  const isCommon = (c: string) => common.includes(canonicalCode(c));

  const slots: ProgrammeSlot[] = year.slots.map((s) => {
    if (!s.routes?.length) return s;
    const routes = s.routes.map((r) => {
      const removed = r.courses.filter(isCommon);
      const lost = removed.reduce((sum, c) => sum + (unitsOf.get(canonicalCode(c)) ?? 0), 0);
      let label = r.label;
      let text = r.text ?? null;
      for (const c of common) {
        label = dropFromLabel(label, c);
        if (text) text = dropFromText(text, c);
      }
      return {
        ...r,
        label,
        text,
        courses: r.courses.filter((c) => !isCommon(c)),
        units: r.units != null ? Math.round((r.units - lost) * 100) / 100 : r.units,
      };
    });
    const targets = routes.map((r) => r.units);
    const sameTarget = targets.every((u) => u != null && u === targets[0]);
    return { ...s, routes, courses: s.courses.filter((c) => !isCommon(c)), units: sameTarget ? (targets[0] ?? null) : null };
  });

  const firstRoute = slots.findIndex((s) => s.routes?.length);
  const paper = year.slots[firstRoute]?.text?.match(/\bPaper\s+\d+\b/i)?.[0];
  const order = Math.max(...year.slots.map((s) => s.order)) + 1;
  const lifted: ProgrammeSlot = {
    order,
    ruleType: "compulsory",
    units: Math.round(common.reduce((sum, c) => sum + (unitsOf.get(c) ?? 0), 0) * 100) / 100,
    courses: common,
    text: `${common.join(" and ")}: part of every ${paper ?? "route"} option, so ${common.length === 1 ? "it is" : "they are"} compulsory`,
    confidence: year.slots[firstRoute]?.confidence ?? "PARTIAL",
    issue: null,
    countsInYearTotal: true,
    ruleTypeRaw: "compulsory (in every route)",
  };
  slots.splice(Math.max(firstRoute, 0), 0, lifted);
  return { ...year, slots };
}

/* ---------- 2. Options to hide ---------- */

/** Courses LSE bars alongside something already in the plan: code → reason. */
export function barredByPlan(details: Map<string, Course | null>, plannedCodes: Iterable<string>): Map<string, string> {
  const planned = new Set([...plannedCodes].map(canonicalCode));
  const out = new Map<string, string>();
  for (const code of planned) {
    for (const p of details.get(code)?.preclusions ?? []) {
      const other = canonicalCode(p.code);
      if (planned.has(other) || out.has(other)) continue;
      out.set(other, `Can’t be taken with ${code}`);
    }
  }
  return out;
}

export const coursePrefixOf = (code: string) => code.match(/^[A-Z]+/)?.[0] ?? "";

export interface PickerFilterContext {
  barred: Map<string, string>;
  /** department prefixes of the chosen degree (EC for BSc Economics) */
  ownPrefixes: Set<string>;
}

/**
 * Why an option is hidden from a picker, or null to show it.
 * Courses already counted in the slot are never hidden (so they can still be removed).
 */
export function pickerHideReason(
  code: string,
  ctx: PickerFilterContext,
  { outsideOption, alreadyHere }: { outsideOption: boolean; alreadyHere: boolean },
): string | null {
  if (alreadyHere) return null;
  const canon = canonicalCode(code);
  const barred = ctx.barred.get(canon);
  if (barred) return barred;
  if (outsideOption && ctx.ownPrefixes.has(coursePrefixOf(canon))) return "From your own department, so not an outside option";
  return null;
}

/* ---------- 3. Named lists from the regulations ---------- */

/** The scraped regulations file (public/data/programmes/2026-<Degree>.json), only the parts used here. */
export interface RegulationsFile {
  name: string;
  years: {
    year: number;
    papers: { label: string; options: string[]; lists: string[]; outside?: "allowed" | "exceptional" | null; lines: string[] }[];
  }[];
  lists: Record<string, string[]>;
}

export interface OptionGroup {
  name: string;
  codes: Set<string>;
  /** an outside-options list; "exceptional" = only in exceptional circumstances */
  outside: "allowed" | "exceptional" | null;
}

const OUTSIDE_LIST = /outside options? list/i;

/** LSE's page calls it the "Additional Section List" (a typo for Selection). */
export const displayListName = (name: string) => name.replace(/\bAdditional Section List\b/i, "Additional Selection List");

/** Groups for one year, in the order the regulations mention them; named courses go in "Other approved courses". */
export function regulationGroups(regs: RegulationsFile | null, year: number): OptionGroup[] {
  const y = regs?.years.find((x) => x.year === year);
  if (!regs || !y) return [];
  const groups: OptionGroup[] = [];
  const named = new Set<string>();
  for (const p of y.papers) {
    for (const name of p.lists) {
      if (groups.some((g) => g.name === displayListName(name))) continue;
      const outside = OUTSIDE_LIST.test(name) ? (p.outside === "exceptional" ? "exceptional" : "allowed") : null;
      groups.push({ name: displayListName(name), codes: new Set((regs.lists[name] ?? []).map(canonicalCode)), outside });
    }
    // Courses a paper names alongside its lists (e.g. BSc Economics Paper 12's AC311 … MA330). Papers with no
    // lists are plain choices (LSE100 versions, MA108 or MA100) and don't need a section.
    if (p.lists.length) for (const c of p.options) named.add(canonicalCode(c));
  }
  // Named courses not already on a subject list. Being on an outside options list doesn't count: those
  // courses are ordinary choices here, so they go in their own section ahead of the outside options.
  const onSubjectLists = new Set(groups.filter((g) => !g.outside).flatMap((g) => [...g.codes]));
  const others = [...named].filter((c) => !onSubjectLists.has(c));
  if (others.length) {
    const firstOutside = groups.findIndex((g) => g.outside);
    groups.splice(firstOutside < 0 ? groups.length : firstOutside, 0, {
      name: "Other approved courses",
      codes: new Set(others),
      outside: null,
    });
  }
  return groups;
}

/** Find a degree's regulations file id from its name ("BSc Economics" → "2026-BScEconomics"). */
export function regulationsId(name: string, cohort = 2026): string {
  const slug = name
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(in|of)\b/gi, " ")
    .replace(/[^A-Za-z0-9]+/g, "");
  return `${cohort}-${slug}`;
}

/* ---------- 4. Compulsory courses and their years ---------- */

/** code → the year the degree requires it in (compulsory, dissertation and LSE100 slots). */
export function compulsoryYears(prog: Programme): Map<string, number> {
  const out = new Map<string, number>();
  for (const y of prog.years) {
    for (const s of y.slots) {
      if (s.ruleType === "compulsory" || s.ruleType === "dissertation") {
        for (const c of s.courses) out.set(canonicalCode(c), y.year);
      }
      if (s.ruleType === "LSE100") {
        for (const a of codeAliases("LSE100")) out.set(a, y.year);
        for (const t of prog.lse100Themes ?? []) for (const a of codeAliases(t)) out.set(a, y.year);
      }
    }
  }
  return out;
}
