"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, Plus, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";
import { NonCreditCourseDialog } from "@/components/NonCreditCourseDialog";
import { isNonCreditUnits } from "@/lib/labels";
import {
  activeRouteId,
  allocateSlots,
  courseUnits,
  crossYearSlotKey,
  exclusiveChoiceCodes,
  findRoute,
  fitsSlotUnits,
  isInactiveOutsideSlot,
  isLockedSlot,
  lockedAutoFillEntries,
  otherRouteCourses,
  shortUnitLabel,
  slotAllowedCodes,
  slotKey,
  courseAssessmentNeedsChecking,
  slotNeedsChecking,
  slotStatusLabel,
  type SlotProgress,
} from "@/lib/degreeLogic";
import { canonicalCode, codesMatch } from "@/lib/courseAliases";
import { getCourseMeta, loadCoursesMeta, type CourseMeta } from "@/lib/coursesData";
import {
  loadProgramme,
  loadProgrammeIndex,
  type CrossYearRule,
  type Programme,
  type ProgrammeRoute,
  type ProgrammeSlot,
  type ProgrammeSummary,
} from "@/lib/programmes";
import { planActions, usePlan } from "@/lib/planStore";
import { fmtUnits, yearUnitCap } from "@/lib/plannerLogic";
import type { IndexEntry } from "@/lib/types";
import { safeHttpsUrl } from "@/lib/urls";
import { cn } from "@/lib/cn";
import { DegreeSearchSelect } from "@/components/DegreeSearchSelect";
import {
  departmentGroups,
  optionPrereqStatus,
  pickerHideReason,
  type OptionGroup,
  type PickerFilterContext,
  type PrereqStatus,
} from "@/lib/builderRules";

export function DegreePanel({ byCode }: { byCode: Map<string, IndexEntry> }) {
  const plan = usePlan();
  const [all, setAll] = useState<ProgrammeSummary[] | null>(null);
  const [prog, setProg] = useState<Programme | null>(null);
  const [courseMeta, setCourseMeta] = useState<Map<string, CourseMeta>>(new Map());
  /** After the user picks a degree, auto-drop locked courses into the plan once data loads. */
  const [pendingFill, setPendingFill] = useState(false);
  /** One-shot: saved degree + empty plan should fill compulsories (incl. LSE100) on hydrate. */
  const hydrateFillDone = useRef(false);

  useEffect(() => {
    loadProgrammeIndex().then(setAll).catch(() => setAll([]));
    loadCoursesMeta()
      .then(setCourseMeta)
      .catch(() => setCourseMeta(new Map()));
  }, []);

  useEffect(() => {
    if (!plan.programme) {
      setProg(null);
      return;
    }
    loadProgramme(plan.programme).then(setProg).catch(() => setProg(null));
  }, [plan.programme]);

  /** Keep plan.years locked to the selected degree length (PPE → 4, most BSc → 3). */
  useEffect(() => {
    if (!prog || prog.id !== plan.programme) return;
    const degreeYears = Math.min(Math.max(prog.lengthYears, 3), 4);
    if (plan.years !== degreeYears) planActions.setYears(degreeYears);
  }, [prog, plan.programme, plan.years]);

  useEffect(() => {
    if (hydrateFillDone.current) return;
    if (!prog || prog.id !== plan.programme) return;
    hydrateFillDone.current = true;
    if (plan.items.length === 0) setPendingFill(true);
  }, [prog, plan.programme, plan.items.length]);

  useEffect(() => {
    if (!pendingFill || !prog || prog.id !== plan.programme) return;
    const degreeYears = Math.min(Math.max(prog.lengthYears, 3), 4);
    planActions.setYears(degreeYears);
    const known = (code: string) =>
      byCode.has(canonicalCode(code)) || courseMeta.has(canonicalCode(code)) || code === "LSE100";
    const entries = lockedAutoFillEntries(prog, known);
    const added = planActions.addMany(entries);
    setPendingFill(false);
    if (added > 0) {
      toast.success(`Added ${added} compulsory course${added === 1 ? "" : "s"}`);
    } else {
      toast.message("No compulsory courses to add for this degree");
    }
  }, [pendingFill, prog, plan.programme, byCode, courseMeta]);

  /** Avoid flashing the previous degree while the next programme JSON loads. */
  const activeProg = prog && prog.id === plan.programme ? prog : null;

  const allocation = useMemo(
    () => (activeProg ? allocateSlots(activeProg, plan, byCode, courseMeta) : null),
    [activeProg, plan, byCode, courseMeta],
  );

  /** Only offer restore when something locked was removed from the plan. */
  const missingCompulsory = useMemo(() => {
    if (!activeProg) return [];
    const known = (code: string) =>
      byCode.has(canonicalCode(code)) || courseMeta.has(canonicalCode(code)) || code === "LSE100";
    const planned = new Set(plan.items.map((i) => canonicalCode(i.code)));
    return lockedAutoFillEntries(activeProg, known).filter(
      (e) => !planned.has(canonicalCode(e.code)),
    );
  }, [activeProg, plan.items, byCode, courseMeta]);

  /** Backfill LSE100 if an earlier fill raced ahead of the catalogue (other Y1 locked courses already in). */
  useEffect(() => {
    if (!activeProg) return;
    const planned = new Set(plan.items.map((i) => canonicalCode(i.code)));
    if (planned.has("LSE100")) return;
    const known = (code: string) =>
      byCode.has(canonicalCode(code)) || courseMeta.has(canonicalCode(code)) || code === "LSE100";
    const locked = lockedAutoFillEntries(activeProg, known);
    const lse = locked.find((e) => e.code === "LSE100");
    if (!lse) return;
    const othersIn = locked.some((e) => e.code !== "LSE100" && planned.has(e.code));
    if (!othersIn) return;
    planActions.addMany([lse]);
  }, [activeProg, plan.items, byCode, courseMeta]);

  if (all === null) {
    return (
      <section className="rounded-[var(--radius)] border border-line bg-surface p-4">
        <p className="text-sm text-muted">Loading degree list…</p>
      </section>
    );
  }

  if (all.length === 0) {
    return (
      <section className="rounded-[var(--radius)] border border-line bg-surface p-4">
        <h2 className="font-display text-lg text-night">Degree requirements</h2>
        <p className="mt-2 text-sm text-muted">
          Couldn’t load programmes. Check your connection and refresh.
        </p>
      </section>
    );
  }

  const options = [...all].sort((a, b) => a.name.localeCompare(b.name));

  const switchTo = (id: string | undefined) => {
    if (id === plan.programme) return;
    planActions.switchProgramme(id);
    if (id) {
      const summary = all.find((p) => p.id === id);
      if (summary) planActions.setYears(Math.min(Math.max(summary.years, 3), 4));
      setPendingFill(true);
    } else {
      setPendingFill(false);
    }
  };

  const fill = () => {
    if (!activeProg) return;
    const degreeYears = Math.min(Math.max(activeProg.lengthYears, 3), 4);
    planActions.setYears(degreeYears);
    const known = (code: string) =>
      byCode.has(canonicalCode(code)) || courseMeta.has(canonicalCode(code)) || code === "LSE100";
    const added = planActions.addMany(lockedAutoFillEntries(activeProg, known));
    toast.success(`Added ${added} compulsory course${added === 1 ? "" : "s"}`);
  };

  const plannedYearAll = new Map(
    plan.items.map((i) => [canonicalCode(i.code), i.year] as const),
  );
  const yearStates = activeProg
    ? activeProg.years
        .filter((y) => y.year <= plan.years)
        .map((y) => ({
          year: y.year,
          unitsLeft: yearUnitsLeft(plan.items, y.year, byCode, courseMeta),
          ...yearSlotState(
            activeProg,
            y,
            allocation,
            plannedYearAll,
            courseMeta,
            yearIsFull(plan.items, y.year, byCode, courseMeta),
          ),
        }))
    : [];

  return (
    <section
      className="rounded-[var(--radius)] border border-line bg-surface p-4"
      aria-label="Your degree"
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <p id="degree-search-label" className="text-sm font-semibold text-night">
            Your degree
          </p>
          <DegreeSearchSelect
            options={options}
            value={plan.programme}
            onChange={switchTo}
            labelledBy="degree-search-label"
          />
        </div>
        {!plan.programme && (
          <p className="text-xs text-muted">
            Pick your degree to drop in its compulsory courses and see what’s left to choose in
            each year.
          </p>
        )}
        {activeProg && (
          <>
            {missingCompulsory.length > 0 && (
              <button
                type="button"
                onClick={fill}
                className="btn-quiet inline-flex w-full items-center justify-center px-4 py-2 text-sm"
              >
                Restore {missingCompulsory.length} Missing Compulsory
                {missingCompulsory.length === 1 ? " Course" : " Courses"}
              </button>
            )}
            <ul
              className="divide-y divide-line overflow-hidden rounded-[var(--radius-inner)] border border-line"
              aria-label="Requirements by year"
            >
              {yearStates.map((ys) => {
                const open = ys.actionSlots.filter((a) => !a.done && !a.spare).length;
                // Slots are often alternatives (an option OR an outside option), so counting
                // open slots overstates the work — show the units still needed instead.
                const badge =
                  ys.unitsLeft < -1e-9
                    ? `${fmtUnits(-ys.unitsLeft)}u over`
                    : ys.unitsLeft > 1e-9
                      ? `${fmtUnits(ys.unitsLeft)}u to choose`
                      : open > 0
                        ? `${open} to fix`
                        : null;
                return (
                  <li key={ys.year}>
                    <a
                      href={`#plan-year-${ys.year}`}
                      className="flex min-h-11 items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-lilac"
                    >
                      <span className="font-medium text-night">Year {ys.year}</span>
                      {badge ? (
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-xs font-semibold",
                            ys.unitsLeft < -1e-9
                              ? "bg-destructive-bg text-destructive"
                              : "bg-lilac text-indigo",
                          )}
                        >
                          {badge}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-status-plan-text">
                          <Check className="size-3.5" aria-hidden />
                          All set
                        </span>
                      )}
                    </a>
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-muted">
              Compulsory courses are added for you. Open choices sit inside each year’s card.{" "}
              <RegulationsNote prog={activeProg} inline />
            </p>
            {activeProg.crossYearRules.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Across years
                </h3>
                <ul className="mt-2 space-y-2">
                  {activeProg.crossYearRules.map((rule) => {
                    const progress = allocation?.get(crossYearSlotKey(rule.order));
                    return (
                      <CrossYearSlotRow
                        key={crossYearSlotKey(rule.order)}
                        rule={rule}
                        prog={activeProg}
                        counted={progress?.counted ?? []}
                        countedUnits={progress?.units ?? 0}
                        byCode={byCode}
                        courseMeta={courseMeta}
                      />
                    );
                  })}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function RegulationsNote({ prog, inline }: { prog: Programme; inline?: boolean }) {
  const href = safeHttpsUrl(prog.url);
  const link = href ? (
    <a href={href} className="underline" target="_blank" rel="noreferrer">
      official programme page
    </a>
  ) : (
    <>official programme page</>
  );
  if (inline) {
    return <>From the {link}.</>;
  }
  return <p className="text-xs text-muted">From the {link}.</p>;
}

function applyRoute(
  year: number,
  pkey: string,
  slot: ProgrammeSlot,
  route: ProgrammeRoute,
  prog: Programme,
) {
  const keep = new Set(route.courses.map(canonicalCode));
  for (const code of otherRouteCourses(slot, route.id)) {
    if (keep.has(canonicalCode(code))) continue;
    planActions.remove(code);
  }
  for (const code of route.courses) {
    planActions.add(canonicalCode(code), year, undefined, pkey);
  }
  // Dependent slots (e.g. Paper 4) may require fixed courses for this same route id.
  const yearSlots = prog.years.find((y) => y.year === year)?.slots ?? [];
  for (const other of yearSlots) {
    if (other.order === slot.order || !other.routes?.length) continue;
    const dep = findRoute(other, route.id);
    const depKey = slotKey(year, other.order);
    for (const r of other.routes) {
      if (r.id === route.id) continue;
      for (const code of r.courses) {
        if (keep.has(canonicalCode(code))) continue;
        if ((dep?.courses ?? []).some((c) => codesMatch(c, code))) continue;
        planActions.remove(code);
      }
    }
    for (const code of dep?.courses ?? []) {
      planActions.add(canonicalCode(code), year, undefined, depKey);
    }
  }
}

/** choose_one_of: keep only this code (or its route bundle); drop the rest. */
function pickExclusiveChoice(
  year: number,
  pkey: string,
  slot: ProgrammeSlot,
  code: string,
  prog: Programme,
) {
  const canon = canonicalCode(code);
  if (slot.routes?.length) {
    const route =
      slot.routes.find((r) => r.courses.some((c) => codesMatch(c, canon))) ?? null;
    if (route) {
      applyRoute(year, pkey, slot, route, prog);
      return;
    }
  }
  for (const other of exclusiveChoiceCodes(slot)) {
    if (other !== canon) planActions.remove(other);
  }
  planActions.add(canon, year, undefined, pkey);
}

/** Drop illegal multi-picks left over from older plans. */
function pruneExclusiveConflicts(year: number, slot: ProgrammeSlot, plannedInYear: Set<string>) {
  if (slot.ruleType !== "choose_one_of") return;
  if (slot.routes?.length) {
    const scored = slot.routes
      .map((r) => {
        const codes = r.courses.map(canonicalCode);
        const hits = codes.filter((c) => plannedInYear.has(c));
        const complete = codes.length > 0 && hits.length === codes.length;
        return { r, hits, complete, score: hits.length + (complete ? 10 : 0) };
      })
      .filter((x) => x.hits.length > 0)
      .sort((a, b) => b.score - a.score);
    if (scored.length <= 1) return;
    const keep = new Set(scored[0].r.courses.map(canonicalCode));
    for (const { r } of scored.slice(1)) {
      for (const c of r.courses) {
        if (!keep.has(canonicalCode(c))) planActions.remove(c);
      }
    }
    return;
  }
  const hits = exclusiveChoiceCodes(slot).filter((c) => plannedInYear.has(c));
  if (hits.length <= 1) return;
  for (const c of hits.slice(1)) planActions.remove(c);
}

function CourseChip({
  code,
  year,
  pkey,
  inPlan,
  locked,
  title,
  units,
  needsCheck,
  overCap,
  capUnits,
  onToggle,
}: {
  code: string;
  year: number;
  pkey: string;
  inPlan: boolean;
  locked?: boolean;
  title?: string;
  units: number | null;
  needsCheck?: boolean;
  /** Adding this course would exceed the slot unit target. */
  overCap?: boolean;
  capUnits?: number | null;
  onToggle?: () => void;
}) {
  const [nonCreditOpen, setNonCreditOpen] = useState(false);
  const unit = shortUnitLabel(units);
  const nonCredit = isNonCreditUnits(units);
  // Empty assessment is expected on non-credit skills courses — don't also flag "check".
  const showCheck = Boolean(needsCheck) && !nonCredit;
  const blocked = Boolean(overCap) && !inPlan;
  // Filled chips: code only (+ "check" if needed). Units / compulsory live in the slot header.
  const parts = [code, inPlan ? null : unit, showCheck ? "check" : null].filter(Boolean);
  const label = `${inPlan ? "" : "+ "}${parts.join(" · ")}`;
  const blockedTitle =
    blocked && capUnits != null
      ? `Would exceed this slot’s ${capUnits}u`
      : blocked
        ? "Would exceed this slot’s unit total"
        : undefined;

  const confirmAdd = () => {
    if (blocked) {
      toast.message(blockedTitle ?? "This slot is already full");
      setNonCreditOpen(false);
      return;
    }
    if (onToggle) onToggle();
    else planActions.add(code, year, undefined, pkey);
    setNonCreditOpen(false);
  };

  const dialog = nonCreditOpen ? (
    <NonCreditCourseDialog
      code={code}
      title={title}
      onClose={() => setNonCreditOpen(false)}
      onConfirmAdd={inPlan ? undefined : confirmAdd}
    />
  ) : null;

  if (locked && inPlan) {
    // Code-only — full course card lives on the year board.
    const chip = (
      <span className="inline-flex min-h-11 items-center rounded-[var(--radius-badge)] border border-line bg-lilac px-2 py-1 text-xs font-medium text-night">
        <span className="chip-code px-1.5 py-0.5 text-[11px] tabular underline-offset-2 group-hover:underline">
          {code}
        </span>
      </span>
    );
    if (!nonCredit) {
      return (
        <Link
          href={`/courses/${code}`}
          title={title ? `${title} — view course` : "View course"}
          aria-label={`View ${code}${title ? `: ${title}` : ""}`}
          className="group inline-flex rounded-[var(--radius-badge)] focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-mint"
        >
          {chip}
        </Link>
      );
    }
    return (
      <>
        <button
          type="button"
          title={title ?? "View course"}
          className="group inline-flex rounded-[var(--radius-badge)] focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-mint"
          onClick={() => setNonCreditOpen(true)}
        >
          {chip}
        </button>
        {dialog}
      </>
    );
  }

  if (locked && !inPlan) {
    return (
      <>
        <button
          type="button"
          title={title ?? "Add compulsory course to plan"}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-[var(--radius-badge)] border border-dashed border-line-strong bg-surface px-2.5 text-xs font-medium text-night hover:bg-lilac"
          onClick={() => {
            if (nonCredit) setNonCreditOpen(true);
            else planActions.add(code, year, undefined, pkey);
          }}
        >
          <span className="chip-code px-1.5 py-0.5 text-[11px] tabular">{code}</span>
          <span className="text-muted">Add</span>
        </button>
        {dialog}
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        title={
          blockedTitle ?? title ?? (nonCredit ? "Non-credit course — tap for details" : undefined)
        }
        disabled={blocked}
        aria-disabled={blocked || undefined}
        className={cn(
          "inline-flex min-h-11 items-center rounded-md px-2.5 text-xs font-medium",
          inPlan
            ? "bg-indigo text-surface"
            : blocked
              ? "cursor-not-allowed border border-line bg-lilac-deep text-muted opacity-70"
              : nonCredit
                ? "border border-mint bg-surface text-night hover:bg-lilac"
                : "border border-line-strong bg-surface text-night hover:bg-lilac",
        )}
        aria-pressed={inPlan}
        onClick={() => {
          if (inPlan) {
            onToggle?.();
            return;
          }
          if (blocked) {
            toast.message(blockedTitle ?? "This slot is already full");
            return;
          }
          if (nonCredit) {
            setNonCreditOpen(true);
            return;
          }
          onToggle?.();
        }}
      >
        {inPlan ? parts.join(" · ") : label}
      </button>
      {dialog}
    </>
  );
}

function SlotRow({
  slot,
  label,
  deferredNote,
  spare,
  done,
  year,
  pkey,
  prog,
  counted,
  countedUnits,
  target,
  byCode,
  courseMeta,
  filters,
  groups = [],
}: {
  slot: ProgrammeSlot;
  label: string;
  deferredNote?: string;
  spare?: boolean;
  done: boolean;
  year: number;
  pkey: string;
  prog: Programme;
  counted: string[];
  countedUnits: number;
  /** unit target given the year's chosen route (falls back to the slot's own) */
  target?: number | null;
  byCode: Map<string, IndexEntry>;
  courseMeta: Map<string, CourseMeta>;
  /** hide courses barred alongside the plan, and own-department "outside" options */
  filters?: PickerFilterContext;
  /** the regulations' named lists for this year, to split the picker into sections */
  groups?: OptionGroup[];
}) {
  const plan = usePlan();
  const planned = new Map(
    plan.items.map((i) => [canonicalCode(i.code), i.year] as const),
  );
  const plannedInYear = new Set(
    [...planned.entries()].filter(([, y]) => y === year).map(([c]) => c),
  );

  const [chooseOther, setChooseOther] = useState(false);

  useEffect(() => {
    pruneExclusiveConflicts(year, slot, plannedInYear);
    // Only when the planned set for this year changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: prune stale multi-picks
  }, [year, slot.order, slot.ruleType, [...plannedInYear].sort().join(",")]);

  if (isInactiveOutsideSlot(slot)) return null;

  const need = target === undefined ? slot.units : target;
  const allowed = slotAllowedCodes(slot, prog, year, courseMeta).codes;
  // An outside-option slot drawing on the general pool: use the official outside options list instead
  // when the regulations give one (keeping only courses the builder can count).
  const officialOutside = slot.ruleType === "outside_option" ? groups.find((g) => g.outside) : undefined;
  const narrowed = officialOutside ? allowed.filter((c) => officialOutside.codes.has(canonicalCode(c))) : allowed;
  const codes = narrowed.length ? narrowed : allowed;
  const locked = isLockedSlot(slot);
  const status = slotStatusLabel(slot, counted, planned, year, countedUnits, need);
  const yearRoute =
    prog.years
      .find((y) => y.year === year)
      ?.slots.map((s) => activeRouteId(s, plannedInYear))
      .find((id) => id != null) ?? null;
  const dependentRoute =
    slot.routes?.length && slot.ruleType !== "choose_one_of" && yearRoute
      ? findRoute(slot, yearRoute)
      : undefined;
  const isRoutePicker = Boolean(slot.routes?.length && slot.ruleType === "choose_one_of");

  // Only codes allowed in this slot — never merge compulsory courses into an options list.
  const showCodes = isRoutePicker
    ? []
    : locked
      ? codes
      : [...new Set([...codes, ...counted.map(canonicalCode).filter((c) => codes.includes(c))])];

  // Hide empty outside-option shells that survived filtering with nothing to pick.
  if (
    slot.ruleType === "outside_option" &&
    showCodes.length === 0 &&
    !dependentRoute?.courses?.length
  ) {
    return null;
  }

  const missingStatus = status === "Missing";
  const lockedPrimaryCode =
    locked && slot.ruleType === "LSE100"
      ? "LSE100"
      : locked && slot.courses.length === 1
        ? canonicalCode(slot.courses[0])
        : null;
  const unitsHint =
    need != null && need > 0 ? (
      <span className="font-data text-xs font-medium text-muted">{need}u</span>
    ) : null;
  // Single locked primary: header owns the code — don't also render an Add chip.
  const hidePrimaryChipRow =
    Boolean(lockedPrimaryCode) &&
    showCodes.length === 1 &&
    canonicalCode(showCodes[0]) === lockedPrimaryCode;
  const lockedPrimaryTitle = lockedPrimaryCode
    ? (byCode.get(lockedPrimaryCode)?.title ?? getCourseMeta(courseMeta, lockedPrimaryCode)?.title)
    : undefined;

  const countedHere = new Set(counted.map(canonicalCode));
  const enforceCap =
    slot.ruleType === "choose_units_from_list" || slot.ruleType === "outside_option";
  // Either/or inside the slot (e.g. Paper 8: Finance FM214 + FM215, or other courses)
  const either = slot.either?.length ? slot.either : null;
  const bundle = either?.find((o) => o.bundle);
  const bundleCodes = new Set((bundle?.courses ?? []).map(canonicalCode));
  const activeEither = !either
    ? null
    : bundle && [...bundleCodes].some((c) => plannedInYear.has(c))
      ? bundle.id
      : counted.some((c) => !bundleCodes.has(canonicalCode(c)))
        ? (either.find((o) => !o.bundle)?.id ?? null)
        : null;
  const showOtherPicker = !either || (activeEither != null && activeEither !== bundle?.id) || (chooseOther && activeEither == null);
  // "a 0.5 unit Autumn Term outside option" (BSc Economics Paper 4 after MA100)
  const autumnOnly = /autumn term/i.test(dependentRoute?.text ?? "");

  const relevantGroups = groups.filter((g) => showCodes.some((c) => g.codes.has(canonicalCode(c))));
  const hiddenRows: HiddenRow[] = [];
  const removeWithUndo = (canon: string) => {
    const item = plan.items.find((i) => canonicalCode(i.code) === canon);
    planActions.remove(canon);
    if (item) {
      toast.message(`Removed ${canon}`, {
        action: { label: "Undo", onClick: () => planActions.add(item.code, item.year, item.slot, item.paper) },
      });
    }
  };
  const rows: PickerRowData[] = locked
    ? []
    : showCodes.flatMap((code) => {
        const canon = canonicalCode(code);
        const known = byCode.has(canon) || courseMeta.has(canon) || canon === "LSE100";
        if (!known) return [];
        const meta = getCourseMeta(courseMeta, code);
        const u = courseUnits(code, byCode, courseMeta);
        const here = countedHere.has(canon);
        const plannedIn = planned.get(canon);
        if (bundleCodes.has(canon)) return []; // shown on the Finance-style option card instead
        if (autumnOnly && !here && plannedIn == null) {
          const terms = byCode.get(canon)?.terms ?? [];
          if (terms.length && !terms.includes("AT")) {
            hiddenRows.push({
              code: canon,
              title: byCode.get(canon)?.title ?? meta?.title,
              reason: "This route needs an Autumn Term course",
            });
            return [];
          }
        }
        if (filters) {
          const group = relevantGroups.find((g) => g.codes.has(canon));
          const why = pickerHideReason(canon, filters, {
            outsideOption: slot.ruleType === "outside_option" || Boolean(group?.outside),
            alreadyHere: here || plannedIn != null,
          });
          if (why) {
            hiddenRows.push({ code: canon, title: byCode.get(canon)?.title ?? meta?.title, reason: why });
            return [];
          }
        }
        const overCap = enforceCap && !here && !fitsSlotUnits(need, countedUnits, u);
        const state: OptionState = here
          ? "here"
          : plannedIn != null
            ? "elsewhere"
            : overCap
              ? "blocked"
              : "available";
        return [
          {
            code: canon,
            title: byCode.get(canon)?.title ?? meta?.title,
            units: u,
            needsCheck: courseAssessmentNeedsChecking(meta),
            state,
            prereq: optionPrereqStatus(canon, year, plan, byCode, courseMeta),
            note:
              state === "elsewhere"
                ? plannedIn === year
                  ? "Used elsewhere"
                  : `In Year ${plannedIn}`
                : state === "blocked"
                  ? "Slot full"
                  : undefined,
            noteTitle:
              state === "elsewhere"
                ? "Already in your plan and counted towards another requirement"
                : state === "blocked"
                  ? need != null
                    ? `Would go over this slot’s ${need}u — remove a course first`
                    : "This slot is already full"
                  : undefined,
            onAdd: () => {
              if (slot.ruleType === "choose_one_of") {
                pickExclusiveChoice(year, pkey, slot, canon, prog);
                return;
              }
              planActions.add(canon, year, undefined, pkey);
            },
            onRemove: () => removeWithUndo(canon),
          },
        ];
      });

  return (
    <li
      className={cn(
        "rounded-[var(--radius-inner)] border p-3 text-sm",
        locked && missingStatus
          ? "border-dashed border-line-strong bg-lilac-deep/60"
          : "border-line bg-surface",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex min-h-7 flex-wrap items-center gap-2 font-medium text-night">
            {lockedPrimaryCode ? (
              <span className="chip-code px-2 py-0.5 text-xs tabular">{lockedPrimaryCode}</span>
            ) : (
              <span>{label}</span>
            )}
            {unitsHint}
          </p>
          {lockedPrimaryTitle ? (
            <p className="mt-0.5 text-xs text-muted">
              {lockedPrimaryTitle}
              {missingStatus ? " · compulsory, not in your plan" : null}
              {status === "Wrong year" ? " · compulsory in this year" : null}
            </p>
          ) : null}
        </div>
        {lockedPrimaryCode && missingStatus ? (
          <button
            type="button"
            className="btn-quiet inline-flex shrink-0 items-center gap-1 px-3 text-sm"
            onClick={() => planActions.add(lockedPrimaryCode, year, undefined, pkey)}
          >
            <Plus className="size-4" aria-hidden />
            Add
          </button>
        ) : (
          <SlotStatus status={spare ? "Optional" : status} done={done} />
        )}
      </div>

      {slotNeedsChecking(slot) && (
        <p className="note-needs-checking mt-2 inline-flex items-start gap-1.5 rounded-[var(--radius-badge)] px-2 py-1.5 text-xs">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            Needs checking
            {slot.issue ? `: ${slot.issue}` : null}
            {!slot.issue && (slot.confidence ?? "").toUpperCase() === "UNVERIFIED"
              ? ": unverified in the source data"
              : null}
          </span>
        </p>
      )}

      {isRoutePicker ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {slot.routes!.map((route, idx) => {
            const active = activeRouteId(slot, plannedInYear) === route.id;
            const routeTag =
              slot.routes!.length === 2
                ? idx === 0
                  ? "Either"
                  : "Or"
                : `Option ${idx + 1}`;
            return (
              <button
                key={route.id}
                type="button"
                aria-pressed={active}
                onClick={() => applyRoute(year, pkey, slot, route, prog)}
                className={cn(
                  "rounded-[var(--radius-inner)] border px-3 py-3 text-left transition",
                  active
                    ? "border-mint bg-status-plan-bg"
                    : "border-line-strong bg-surface hover:bg-lilac",
                )}
              >
                <p className="flex items-center gap-1 text-xs font-semibold text-muted">
                  {active ? <Check className="size-3.5 text-status-plan-text" aria-hidden /> : null}
                  {active ? "Chosen" : routeTag}
                </p>
                <p className="mt-0.5 font-medium text-night">{route.label}</p>
                {route.courses.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {route.courses.map((code) => (
                      <span
                        key={code}
                        className="inline-flex items-center rounded-md bg-lilac px-2 py-1 font-data text-[11px] font-bold text-indigo"
                      >
                        {code}
                        {shortUnitLabel(courseUnits(code, byCode, courseMeta))
                          ? ` · ${shortUnitLabel(courseUnits(code, byCode, courseMeta))}`
                          : ""}
                      </span>
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      ) : null}

      {dependentRoute?.courses?.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {dependentRoute.courses.map((code) => {
            const canon = canonicalCode(code);
            return (
              <CourseChip
                key={code}
                code={canon}
                year={year}
                pkey={pkey}
                inPlan={planned.has(canon)}
                locked
                title={byCode.get(canon)?.title ?? getCourseMeta(courseMeta, code)?.title}
                units={courseUnits(code, byCode, courseMeta)}
                needsCheck={courseAssessmentNeedsChecking(getCourseMeta(courseMeta, code))}
              />
            );
          })}
        </div>
      ) : null}

      {locked && showCodes.length > 0 && !hidePrimaryChipRow && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {showCodes.map((code) => {
            const canon = canonicalCode(code);
            const known = byCode.has(canon) || courseMeta.has(canon) || canon === "LSE100";
            if (!known) {
              return (
                <span
                  key={code}
                  className="inline-flex min-h-11 items-center rounded-[var(--radius-badge)] border border-dashed border-line-strong px-2.5 text-xs text-muted"
                  title="Not in the current catalogue"
                >
                  {code}
                </span>
              );
            }
            const meta = getCourseMeta(courseMeta, code);
            return (
              <CourseChip
                key={code}
                code={canon}
                year={year}
                pkey={pkey}
                inPlan={planned.has(canon)}
                locked
                title={byCode.get(canon)?.title ?? meta?.title}
                units={courseUnits(code, byCode, courseMeta)}
                needsCheck={courseAssessmentNeedsChecking(meta)}
              />
            );
          })}
        </div>
      )}

      {either ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {either.map((opt, idx) => {
            const active = activeEither === opt.id || (opt.id !== bundle?.id && chooseOther && activeEither == null);
            const tag = activeEither === opt.id ? "Chosen" : idx === 0 ? "Either" : "Or";
            return (
              <button
                key={opt.id}
                type="button"
                aria-pressed={activeEither === opt.id}
                onClick={() => {
                  if (opt.bundle) {
                    // Switch to the bundle: drop other picks counted here, add the bundle's courses
                    for (const c of counted) if (!bundleCodes.has(canonicalCode(c))) planActions.remove(c);
                    for (const c of opt.courses ?? []) planActions.add(canonicalCode(c), year, undefined, pkey);
                    setChooseOther(false);
                  } else {
                    // Switch to the list: drop the bundle's courses, then pick from the list
                    for (const c of bundleCodes) if (plannedInYear.has(c)) planActions.remove(c);
                    setChooseOther(true);
                  }
                }}
                className={cn(
                  "rounded-[var(--radius-inner)] border px-3 py-3 text-left transition",
                  active ? "border-mint bg-status-plan-bg" : "border-line-strong bg-surface hover:bg-lilac",
                )}
              >
                <p className="flex items-center gap-1 text-xs font-semibold text-muted">
                  {activeEither === opt.id ? <Check className="size-3.5 text-status-plan-text" aria-hidden /> : null}
                  {tag}
                </p>
                <p className="mt-0.5 font-medium text-night">{opt.label}</p>
                {opt.note ? <p className="mt-0.5 text-xs text-muted">{opt.note}</p> : null}
                {opt.bundle && (opt.courses?.length ?? 0) > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {opt.courses!.map((code) => (
                      <span
                        key={code}
                        className="inline-flex items-center rounded-md bg-lilac px-2 py-1 font-data text-[11px] font-bold text-indigo"
                      >
                        {code}
                        {shortUnitLabel(courseUnits(code, byCode, courseMeta))
                          ? ` · ${shortUnitLabel(courseUnits(code, byCode, courseMeta))}`
                          : ""}
                      </span>
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      ) : null}

      {showOtherPicker && (rows.length > 0 || hiddenRows.length > 0) && (
        <PickerList
          rows={rows}
          done={done}
          label={label}
          deferredNote={deferredNote}
          hidden={hiddenRows}
          groups={
            relevantGroups.length
              ? relevantGroups
              : rows.length > 8
                ? departmentGroups(
                    rows.map((r) => ({ code: r.code, department: byCode.get(r.code)?.department ?? getCourseMeta(courseMeta, r.code)?.department ?? null })),
                    filters?.ownPrefixes ?? new Set(),
                  )
                : []
          }
        />
      )}
    </li>
  );
}

type OptionState = "here" | "elsewhere" | "available" | "blocked";

interface PickerRowData {
  code: string;
  title?: string;
  units: number | null;
  needsCheck: boolean;
  state: OptionState;
  /** Short reason shown instead of an Add button ("In Year 2", "Slot full"). */
  note?: string;
  noteTitle?: string;
  /** whether the course's prerequisites would be met in this year (null = none listed) */
  prereq?: PrereqStatus | null;
  onAdd: () => void;
  onRemove: () => void;
}

const STATE_ORDER: Record<OptionState, number> = { here: 0, available: 1, blocked: 2, elsewhere: 3 };
/** Lists longer than this get a search box and their own scrolling area. */
const LONG_LIST = 8;

interface HiddenRow {
  code: string;
  title?: string;
  reason: string;
}

interface Section {
  name: string | null;
  outside: OptionGroup["outside"];
  rows: PickerRowData[];
}

/** Split rows into the regulations' named lists, in their order; anything else goes last. */
function sectionRows(rows: PickerRowData[], groups: OptionGroup[]): Section[] {
  if (groups.length === 0) return [{ name: null, outside: null, rows }];
  const sections: Section[] = groups.map((g) => ({ name: g.name, outside: g.outside, rows: [] }));
  const other: Section = { name: "Other options", outside: null, rows: [] };
  for (const r of rows) {
    const i = groups.findIndex((g) => g.codes.has(r.code));
    (i >= 0 ? sections[i] : other).rows.push(r);
  }
  return [...sections, other].filter((x) => x.rows.length > 0);
}

/**
 * Option rows for a requirement slot. Chosen courses always sit at the top with a remove button.
 * Long lists get a search box that stays put while the list scrolls in its own area, split into the
 * regulations' named lists when known. Courses that can't be taken are hidden behind a "Show" toggle.
 */
function PickerList({
  rows,
  done,
  label,
  deferredNote,
  hidden = [],
  groups = [],
}: {
  rows: PickerRowData[];
  done: boolean;
  label: string;
  /** Set when an earlier slot offers the same list — start collapsed to avoid repeating it. */
  deferredNote?: string;
  hidden?: HiddenRow[];
  groups?: OptionGroup[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  // Which sub-lists are open (all closed to start, so the lists themselves are the overview)
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());
  const toggleSection = (key: string) =>
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const filterId = useId();

  const here = rows.filter((r) => r.state === "here");
  const rest = rows
    .filter((r) => r.state !== "here")
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
  const q = query.trim().toLowerCase();
  const filtered = q
    ? rest.filter((r) => r.code.toLowerCase().includes(q) || (r.title ?? "").toLowerCase().includes(q))
    : rest;
  const listOpen = expanded || (!done && !deferredNote);
  const long = rest.length > LONG_LIST;

  const chosen =
    here.length > 0 ? (
      <ul className="space-y-1.5" aria-label={`${label}: chosen`}>
        {here.map((r) => (
          <OptionRow key={r.code} row={r} />
        ))}
      </ul>
    ) : null;

  const hiddenNote =
    hidden.length > 0 ? (
      <div className="text-xs text-muted">
        <button
          type="button"
          className="inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-control)] px-1 text-left font-medium text-indigo hover:bg-lilac"
          aria-expanded={showHidden}
          onClick={() => setShowHidden((v) => !v)}
        >
          {showHidden ? "Hide" : "Show"} {hidden.length} Not Offered
          <ChevronDown className={cn("size-4 transition-transform", showHidden && "rotate-180")} aria-hidden />
        </button>
        <span> — you can’t take {hidden.length === 1 ? "it" : "them"} alongside your plan, or {hidden.length === 1 ? "it’s" : "they’re"} from your own department.</span>
        {showHidden && (
          <ul className="mt-1 space-y-1" aria-label={`${label}: not offered`}>
            {hidden.map((h) => (
              <li key={h.code} className="flex flex-wrap items-baseline gap-x-2 px-1">
                <Link href={`/courses/${h.code}`} className="font-data font-semibold text-indigo hover:underline">
                  {h.code}
                </Link>
                <span className="min-w-0 flex-1">{h.title ?? ""}</span>
                <span className="text-[11px]">{h.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    ) : null;

  if (!listOpen) {
    return (
      <div className="mt-2 space-y-2">
        {chosen}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {deferredNote && !done ? <p className="min-w-0 flex-1 text-xs text-muted">{deferredNote}</p> : <span />}
          {rest.length > 0 && (
            <button
              type="button"
              className={done ? "inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-control)] px-2 text-sm font-medium text-indigo hover:bg-lilac" : "btn-quiet inline-flex items-center gap-1 px-3 text-sm"}
              onClick={() => setExpanded(true)}
              aria-label={`${done ? "Change" : "Choose for"} ${label}`}
            >
              {done ? "Change" : "Choose"}
              <ChevronDown className="size-4" aria-hidden />
            </button>
          )}
        </div>
      </div>
    );
  }

  const sections = sectionRows(filtered, groups);
  const multi = sections.length > 1;
  const listFor = (rs: PickerRowData[]) => (
    <ul className="space-y-1.5">
      {rs.map((r) => (
        <OptionRow key={r.code} row={r} />
      ))}
    </ul>
  );
  const exceptionalNote = (
    <p className="px-1 pb-1 text-xs text-muted">Only in exceptional circumstances, with your department’s permission.</p>
  );
  const body =
    filtered.length === 0 ? (
      <p className="px-1 py-2 text-xs text-muted">No options match “{query.trim()}”.</p>
    ) : multi ? (
      // One collapsible sub-list per named list (or department); each scrolls on its own when opened
      <div className="space-y-2">
        {sections.map((sec) => {
          const key = sec.name ?? "Other options";
          const isOpen = openSections.has(key) || Boolean(q);
          return (
            <section key={key} aria-label={key}>
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => toggleSection(key)}
                className="flex min-h-11 w-full items-center justify-between gap-2 rounded-[var(--radius-inner)] border border-line bg-surface px-3 text-left text-sm font-medium text-night hover:bg-lilac"
              >
                <span className="min-w-0">
                  {key} <span className="font-data text-xs text-muted">({sec.rows.length})</span>
                  {sec.outside === "exceptional" ? (
                    <span className="block text-[11px] font-normal text-muted">Exceptional circumstances only</span>
                  ) : null}
                </span>
                <ChevronDown className={cn("size-4 shrink-0 transition-transform", isOpen && "rotate-180")} aria-hidden />
              </button>
              {isOpen && (
                <div className="mt-1.5">
                  {sec.outside === "exceptional" && exceptionalNote}
                  <div
                    className={cn(
                      sec.rows.length > LONG_LIST &&
                        "max-h-72 overflow-y-auto overscroll-contain rounded-[var(--radius-inner)] border border-line p-1.5",
                    )}
                    role="region"
                    aria-label={`${key}: options`}
                    tabIndex={sec.rows.length > LONG_LIST ? 0 : undefined}
                  >
                    {listFor(sec.rows)}
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>
    ) : (
      <div>
        {sections[0]?.outside === "exceptional" && exceptionalNote}
        {listFor(filtered)}
      </div>
    );

  return (
    <div className="mt-2 space-y-2">
      {chosen}
      {long ? (
        <div className="space-y-2">
          <div>
            <label htmlFor={filterId} className="sr-only">
              Search {label} options
            </label>
            <input
              id={filterId}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${rest.length} options by code or title`}
              className="field-input"
              autoComplete="off"
            />
          </div>
          {/* The list scrolls in its own area (or each sub-list does), so the search box stays in view. */}
          {multi ? (
            body
          ) : (
            <div
              className="max-h-80 overflow-y-auto overscroll-contain rounded-[var(--radius-inner)] border border-line p-1.5"
              role="region"
              aria-label={`${label}: options`}
              tabIndex={0}
            >
              {body}
            </div>
          )}
        </div>
      ) : (
        body
      )}
      {hiddenNote}
      {(done || deferredNote) && expanded && (
        <div className="flex justify-end">
          <button
            type="button"
            className="inline-flex min-h-11 items-center rounded-[var(--radius-control)] px-2 text-sm font-medium text-indigo hover:bg-lilac"
            onClick={() => {
              setExpanded(false);
              setQuery("");
            }}
          >
            {done ? "Done" : "Hide"}
          </button>
        </div>
      )}
    </div>
  );
}

function OptionRow({ row }: { row: PickerRowData }) {
  const [nonCreditOpen, setNonCreditOpen] = useState(false);
  const nonCredit = isNonCreditUnits(row.units);
  const unit = shortUnitLabel(row.units);
  const add = () => {
    if (nonCredit) setNonCreditOpen(true);
    else row.onAdd();
  };
  const muted = row.state === "elsewhere" || row.state === "blocked";

  return (
    <li
      className={cn(
        "flex min-h-12 items-center gap-2 rounded-[var(--radius-badge)] border py-1 pl-2 pr-1",
        row.state === "here"
          ? "border-status-plan-border bg-status-plan-bg"
          : "border-line bg-surface",
      )}
    >
      <Link
        href={`/courses/${row.code}`}
        className="group flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-badge)] focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-mint"
        title={row.prereq?.wording ? `Prerequisites: ${row.prereq.wording}` : "View course"}
      >
        <span className="chip-code shrink-0 px-1.5 py-0.5 text-[11px] tabular underline-offset-2 group-hover:underline">
          {row.code}
        </span>
        <span className={cn("min-w-0 flex-1", muted && "opacity-70")}>
          <span className="line-clamp-2 text-xs font-medium leading-snug text-night underline-offset-2 group-hover:underline">
            {row.title ?? "Title not in catalogue"}
          </span>
          {row.needsCheck && !nonCredit ? (
            <span className="text-[11px] text-status-check-text">Assessment needs checking</span>
          ) : null}
          {row.prereq ? (
            row.prereq.met ? (
              <span className="block text-[11px] text-status-plan-text">
                ✓ Prerequisites met{row.prereq.via ? ` (counting ${row.prereq.via})` : ""}
              </span>
            ) : (
              <span className="block text-[11px] text-status-check-text">{row.prereq.needs} first</span>
            )
          ) : null}
        </span>
      </Link>
      {unit ? <span className="shrink-0 font-data text-[11px] text-muted">{unit}</span> : null}
      {row.state === "here" ? (
        <button
          type="button"
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-muted hover:bg-destructive-bg hover:text-destructive"
          aria-label={`Remove ${row.code}${row.title ? `: ${row.title}` : ""}`}
          onClick={row.onRemove}
        >
          <X className="size-4" aria-hidden />
        </button>
      ) : row.state === "available" ? (
        <button
          type="button"
          className="btn-quiet inline-flex shrink-0 items-center gap-1 px-2.5 text-xs"
          aria-label={`Add ${row.code}${row.title ? `: ${row.title}` : ""}`}
          onClick={add}
        >
          <Plus className="size-3.5" aria-hidden />
          Add
        </button>
      ) : (
        <span
          className="inline-flex min-h-11 shrink-0 items-center px-2 text-[11px] font-medium text-muted"
          title={row.noteTitle}
        >
          {row.note}
        </span>
      )}
      {nonCreditOpen ? (
        <NonCreditCourseDialog
          code={row.code}
          title={row.title}
          onClose={() => setNonCreditOpen(false)}
          onConfirmAdd={() => {
            row.onAdd();
            setNonCreditOpen(false);
          }}
        />
      ) : null}
    </li>
  );
}

function prettyStatus(status: string): string {
  const s = status.replace(" / ", " of ");
  if (s === "choose") return "Choose 1";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function SlotStatus({ status, done }: { status: string; done: boolean }) {
  if (done) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-status-plan-bg px-2 py-0.5 text-xs font-medium text-status-plan-text">
        <Check className="size-3.5" aria-hidden />
        Done
      </span>
    );
  }
  if (status === "Wrong year") {
    return (
      <span className="note-needs-checking shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium">
        Wrong year
      </span>
    );
  }
  if (status === "Missing" || status === "Optional") {
    return <span className="shrink-0 pt-0.5 text-xs font-medium text-muted">{status}</span>;
  }
  return (
    <span className="shrink-0 rounded-full bg-lilac px-2 py-0.5 text-xs font-semibold text-indigo">
      {prettyStatus(status)}
    </span>
  );
}

function CrossYearSlotRow({
  rule,
  prog,
  counted,
  countedUnits,
  byCode,
  courseMeta,
}: {
  rule: CrossYearRule;
  prog: Programme;
  counted: string[];
  countedUnits: number;
  byCode: Map<string, IndexEntry>;
  courseMeta: Map<string, CourseMeta>;
}) {
  const plan = usePlan();
  const planned = new Map(plan.items.map((i) => [canonicalCode(i.code), i.year] as const));
  const defaultYear = rule.appliesToYears[0] ?? 2;
  const pkey = crossYearSlotKey(rule.order);
  const { codes } = slotAllowedCodes(rule, prog, defaultYear, courseMeta);
  const showCodes = [...new Set([...codes, ...counted.map(canonicalCode)])];
  const countedHere = new Set(counted.map(canonicalCode));
  const done =
    rule.units != null && rule.units > 0
      ? countedUnits + 1e-9 >= rule.units
      : counted.length > 0;
  const status = counted.length
    ? `${shortUnitLabel(countedUnits) ?? ""}${rule.units != null ? ` / ${rule.units}u` : ""}`.trim()
    : rule.units != null
      ? `choose ${rule.units}u`
      : "Optional";

  const rows: PickerRowData[] = showCodes.flatMap((code) => {
    const canon = canonicalCode(code);
    if (!(byCode.has(canon) || courseMeta.has(canon))) return [];
    const meta = getCourseMeta(courseMeta, code);
    const u = courseUnits(code, byCode, courseMeta);
    const here = countedHere.has(canon);
    const plannedIn = planned.get(canon);
    const overCap = !here && !fitsSlotUnits(rule.units, countedUnits, u);
    const state: OptionState = here
      ? "here"
      : plannedIn != null
        ? "elsewhere"
        : overCap
          ? "blocked"
          : "available";
    return [
      {
        code: canon,
        title: byCode.get(canon)?.title ?? meta?.title,
        units: u,
        needsCheck: courseAssessmentNeedsChecking(meta),
        state,
        note: state === "elsewhere" ? `In Year ${plannedIn}` : state === "blocked" ? "Slot full" : undefined,
        noteTitle:
          state === "blocked"
            ? rule.units != null
              ? `Would go over this rule’s ${rule.units}u — remove a course first`
              : "Already full"
            : undefined,
        onAdd: () => planActions.add(canon, defaultYear, undefined, pkey),
        onRemove: () => planActions.remove(canon),
      },
    ];
  });

  return (
    <li className="rounded-[var(--radius-inner)] border border-line bg-surface p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-night">
            {slotLabel(rule)}
            {rule.units != null && rule.units > 0 ? (
              <span className="ml-1.5 font-data text-xs font-medium text-muted">{rule.units}u</span>
            ) : null}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            Years {rule.years} · added to Year {defaultYear}; move it from its card if needed.
          </p>
        </div>
        <SlotStatus status={status} done={done} />
      </div>

      {slotNeedsChecking(rule) && (
        <p className="note-needs-checking mt-2 inline-flex items-start gap-1.5 rounded-[var(--radius-badge)] px-2 py-1.5 text-xs">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            Needs checking
            {rule.issue ? `: ${rule.issue}` : null}
            {!rule.issue && (rule.confidence ?? "").toUpperCase() === "UNVERIFIED"
              ? ": unverified in the source data"
              : null}
          </span>
        </p>
      )}

      {rows.length > 0 && <PickerList rows={rows} done={done} label={slotLabel(rule)} />}
    </li>
  );
}

type ProgrammeYearDef = Programme["years"][number];

interface ActionSlot {
  slot: ProgrammeSlot;
  done: boolean;
  /** Open choice in a year that already has its full units — only needed after a swap. */
  spare: boolean;
  counted: string[];
  units: number;
  /** unit target given the year's chosen route */
  target: number | null;
}

/** Units still to plan before the year reaches its normal load (4u, or 4.5u in Year 1). */
function yearUnitsLeft(
  items: { code: string; year: number }[],
  year: number,
  byCode: Map<string, IndexEntry>,
  courseMeta: Map<string, CourseMeta>,
): number {
  const units = items
    .filter((i) => i.year === year)
    .reduce((sum, i) => sum + (courseUnits(i.code, byCode, courseMeta) ?? 0), 0);
  return Math.round((yearUnitCap(year) - units) * 100) / 100;
}

/** True when the year's planned units already reach its normal load. */
function yearIsFull(
  items: { code: string; year: number }[],
  year: number,
  byCode: Map<string, IndexEntry>,
  courseMeta: Map<string, CourseMeta>,
): boolean {
  return yearUnitsLeft(items, year, byCode, courseMeta) <= 1e-9;
}

function slotDone(
  slot: ProgrammeSlot,
  status: string,
  countedUnits: number,
  target: number | null = slot.units,
): boolean {
  if (status === "In plan" || status.startsWith("Route")) return true;
  if (!isLockedSlot(slot) && target != null && target > 0) {
    return countedUnits + 1e-9 >= target;
  }
  return false;
}

/**
 * Requirement slots for one programme year that still need the student's attention (or that
 * hold a choice they made). Compulsory courses already in the right year are "met" and live
 * only on the year board.
 */
export function yearSlotState(
  prog: Programme,
  y: ProgrammeYearDef,
  allocation: Map<string, SlotProgress> | null,
  plannedYear: Map<string, number>,
  courseMeta: Map<string, CourseMeta>,
  yearFull = false,
): { actionSlots: ActionSlot[]; metLocked: number } {
  let metLocked = 0;
  const actionSlots: ActionSlot[] = [];
  for (const slot of y.slots) {
    if (isInactiveOutsideSlot(slot)) continue;
    const progress = allocation?.get(slotKey(y.year, slot.order));
    const counted = progress?.counted ?? [];
    const units = progress?.units ?? 0;
    const target = progress ? progress.target : slot.units;
    const status = slotStatusLabel(slot, counted, plannedYear, y.year, units, target);
    if (isLockedSlot(slot) && status === "In plan") {
      metLocked += 1;
      continue;
    }
    if (
      slot.ruleType === "outside_option" &&
      !slot.routes?.length &&
      slotAllowedCodes(slot, prog, y.year, courseMeta).codes.length === 0
    ) {
      continue;
    }
    const done = slotDone(slot, status, units, target);
    const spare = !done && yearFull && !isLockedSlot(slot) && counted.length === 0;
    actionSlots.push({ slot, done, spare, counted, units, target });
  }
  return { actionSlots, metLocked };
}

/** "Still to choose" block rendered inside a YearBoard card. */
export function YearRequirements({
  prog,
  year,
  allocation,
  byCode,
  courseMeta,
  filters,
  groups,
}: {
  prog: Programme;
  year: number;
  allocation: Map<string, SlotProgress> | null;
  byCode: Map<string, IndexEntry>;
  courseMeta: Map<string, CourseMeta>;
  filters?: PickerFilterContext;
  groups?: OptionGroup[];
}) {
  const plan = usePlan();
  const [reviewOpen, setReviewOpen] = useState(false);
  const y = prog.years.find((py) => py.year === year);
  if (!y) return null;
  const plannedYear = new Map(plan.items.map((i) => [canonicalCode(i.code), i.year] as const));
  const unitsLeft = yearUnitsLeft(plan.items, year, byCode, courseMeta);
  const yearFull = unitsLeft <= 1e-9;
  const { actionSlots } = yearSlotState(prog, y, allocation, plannedYear, courseMeta, yearFull);
  if (actionSlots.length === 0) return null;

  const open = actionSlots.filter((a) => !a.done && !a.spare).length;
  const base = actionSlots.map((a) => slotLabel(a.slot));
  const totals = new Map<string, number>();
  for (const l of base) totals.set(l, (totals.get(l) ?? 0) + 1);
  const seen = new Map<string, number>();
  const labels = base.map((l) => {
    const total = totals.get(l) ?? 0;
    if (total < 2) return l;
    const n = (seen.get(l) ?? 0) + 1;
    seen.set(l, n);
    return `${l} — choice ${n} of ${total}`;
  });
  // Several slots often share one option list (e.g. "Options" ×3). Keep only the first open
  // one expanded; the rest wait behind a Choose button instead of repeating the same list.
  const firstOpenByBase = new Map<string, number>();
  actionSlots.forEach((a, i) => {
    if (!a.done && !a.spare && !firstOpenByBase.has(base[i])) firstOpenByBase.set(base[i], i);
  });
  const deferred = actionSlots.map((a, i) => {
    if (a.spare) {
      return `Year ${year} already has ${fmtUnits(yearUnitCap(year))} units — only needed if you swap a course out.`;
    }
    const first = firstOpenByBase.get(base[i]);
    if (a.done || a.counted.length > 0 || first == null || first === i) return undefined;
    return `Same list as ${labels[first]}.`;
  });

  if (open === 0 && !reviewOpen) {
    return (
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <p className="inline-flex items-center gap-1.5 text-sm font-medium text-status-plan-text">
          <Check className="size-4" aria-hidden />
          All degree choices for Year {year} made
        </p>
        <button
          type="button"
          className="inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-control)] px-2 text-sm font-medium text-indigo hover:bg-lilac"
          onClick={() => setReviewOpen(true)}
        >
          Review
          <ChevronDown className="size-4" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-night">
          {open > 0 ? "Still to choose" : "Degree choices"}
        </h3>
        {open > 0 ? (
          <p className="text-xs text-muted">
            {unitsLeft > 1e-9
              ? `${fmtUnits(unitsLeft)} ${unitsLeft === 1 ? "unit" : "units"} left to plan`
              : `${open} to fix`}
          </p>
        ) : (
          <button
            type="button"
            className="inline-flex min-h-11 items-center rounded-[var(--radius-control)] px-2 text-sm font-medium text-indigo hover:bg-lilac"
            onClick={() => setReviewOpen(false)}
          >
            Hide
          </button>
        )}
      </div>
      <ul className="mt-2 space-y-2">
        {actionSlots.map((a, i) => (
          <SlotRow
            key={slotKey(year, a.slot.order)}
            slot={a.slot}
            label={labels[i]}
            deferredNote={deferred[i]}
            spare={a.spare}
            done={a.done}
            year={year}
            pkey={slotKey(year, a.slot.order)}
            prog={prog}
            counted={a.counted}
            countedUnits={a.units}
            target={a.target}
            byCode={byCode}
            courseMeta={courseMeta}
            filters={filters}
            groups={groups}
          />
        ))}
      </ul>
    </div>
  );
}

function slotLabel(slot: ProgrammeSlot): string {
  // "Paper 3", and also "Papers 9 & 10" / "Papers 9 and 10" for slots covering several papers
  const paper = slot.text?.match(/\b(Papers?\s+\d+(?:\s*(?:&|and|,)\s*\d+)*)\b/i)?.[1];
  if (paper) {
    if (slot.ruleType === "choose_one_of" && slot.routes?.length) return `${paper} · maths route`;
    if (slot.ruleType === "outside_option") return `${paper} · outside options`;
    return paper;
  }
  switch (slot.ruleType) {
    case "compulsory":
      return slot.courses.length === 1 ? slot.courses[0] : "Compulsory";
    case "dissertation":
      return slot.courses[0] ? `Dissertation · ${slot.courses[0]}` : "Dissertation";
    case "LSE100":
      return "LSE100";
    case "choose_one_of":
      return slot.routes?.length ? "Choose a route" : "Choose one";
    case "choose_units_from_list":
      return "Options";
    case "outside_option":
      return "Outside option";
    default:
      return slot.ruleType;
  }
}
