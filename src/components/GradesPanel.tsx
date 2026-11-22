"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import {
  analyse,
  marksFor,
  parseMarkInput,
  schemeForYears,
  statusLabel,
  TARGET_OPTIONS,
  targetLabel,
  type GradeCourse,
  type TargetClass,
  type TargetResult,
} from "@/lib/gradeLogic";
import { isValidCourseCode } from "@/lib/async";
import { gradeActions, useGrades } from "@/lib/gradeStore";
import type { Plan } from "@/lib/planStore";
import type { IndexEntry } from "@/lib/types";
import { unitLabel } from "@/lib/labels";
import { cn } from "@/lib/cn";
import { MenuSelect } from "./MenuSelect";

function TargetClassSegment({
  value,
  onChange,
  labelledBy,
}: {
  value: TargetClass;
  onChange: (next: TargetClass) => void;
  labelledBy: string;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const index = Math.max(0, TARGET_OPTIONS.indexOf(value));
  const count = TARGET_OPTIONS.length;

  const select = (next: TargetClass) => {
    onChange(next);
    const i = TARGET_OPTIONS.indexOf(next);
    requestAnimationFrame(() => {
      const radios = groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]');
      radios?.[i]?.focus();
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      select(TARGET_OPTIONS[(index + 1) % count]!);
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      select(TARGET_OPTIONS[(index - 1 + count) % count]!);
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      select(TARGET_OPTIONS[0]!);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      select(TARGET_OPTIONS[count - 1]!);
    }
  };

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-labelledby={labelledBy}
      className="relative grid w-full grid-cols-3 gap-1 rounded-[var(--radius-control)] border border-line bg-lilac-deep p-1 md:grid-cols-6 md:gap-0"
      onKeyDown={onKeyDown}
    >
      {/* Desktop sliding thumb; mobile uses per-cell mint fill instead */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-1 left-1 z-0 hidden w-[calc((100%-0.5rem)/6)] rounded-[calc(var(--radius-control)-4px)] bg-mint shadow-sm transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none md:block"
        style={{ transform: `translateX(${index * 100}%)` }}
      />
      {TARGET_OPTIONS.map((cls) => {
        const active = cls === value;
        return (
          <button
            key={cls}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={targetLabel(cls)}
            tabIndex={active ? 0 : -1}
            className={cn(
              "relative z-10 min-h-11 rounded-[calc(var(--radius-control)-4px)] px-1.5 text-sm font-semibold transition-colors duration-200 motion-reduce:transition-none",
              active
                ? "bg-mint text-night md:bg-transparent"
                : "text-muted hover:bg-lilac hover:text-night md:hover:bg-transparent md:hover:text-night",
            )}
            onClick={() => select(cls)}
          >
            {cls}
          </button>
        );
      })}
    </div>
  );
}

function AimOption({
  label,
  headline,
  detail,
}: {
  label?: string;
  headline: string;
  detail?: string;
}) {
  return (
    <div className="min-w-0">
      {label ? <p className="text-xs font-medium text-muted">{label}</p> : null}
      <p
        className={cn(
          "text-base font-semibold leading-snug text-night",
          label ? "mt-1" : null,
        )}
      >
        {headline}
      </p>
      {detail ? <p className="mt-1 text-sm leading-relaxed text-muted">{detail}</p> : null}
    </div>
  );
}

function targetStatusNote(t: TargetResult): string | null {
  if (t.note && (t.cls === "Pass" || t.cls === "Fail")) return t.note;
  if (t.status === "secured") {
    return "You've already got enough scores at this level, subject to fail penalties.";
  }
  if (t.status === "out_of_reach") {
    return "Not reachable with the scores left, even if everything remaining is 100.";
  }
  return null;
}

/** Official-style mark wording, e.g. "10 first-class marks" / "10 marks of 60+". */
function marksAtThreshold(n: number, t: TargetResult): string {
  const noun = n === 1 ? "mark" : "marks";
  if (t.cls === "First") return `${n} first-class ${noun}`;
  return `${n} ${noun} of ${t.threshold}+`;
}

function buildAimOptions(
  t: TargetResult,
  remaining: number,
): { label?: string; headline: string; detail?: string }[] {
  const options: { label?: string; headline: string; detail?: string }[] = [];

  // Honours: mirror Calendar wording (3-year First = 10, or 9/8 + aggregate 1180;
  // 4-year First = 14, or 13/12 + aggregate 1700; same shape for 2:1 / 2:2).
  if (
    t.marksNeeded != null &&
    t.minMarks != null &&
    t.aggregate != null &&
    (t.cls === "First" || t.cls === "2:1" || t.cls === "2:2")
  ) {
    const have =
      t.routeMarks != null
        ? t.marksNeeded - t.routeMarks
        : t.status === "secured"
          ? t.marksNeeded
          : null;

    let detailA: string | undefined;
    if (t.routeMarks == null) {
      detailA = "Not enough scores left for this route.";
    } else if (t.routeMarks === 0) {
      detailA = "You've hit this mark count.";
    } else if (have != null) {
      detailA = `You have ${have} so far · need ${t.routeMarks} more (${remaining} still to enter).`;
    }

    options.push({
      label: "Option A",
      headline: marksAtThreshold(t.marksNeeded, t),
      detail: detailA,
    });

    const hi = t.minMarks + 1;
    const lo = t.minMarks;
    let detailB: string | undefined;
    if (t.routeAggMarks == null) {
      detailB = "Not enough scores left for this route.";
    } else if (t.routeAggMarks === 0) {
      detailB = `Keep the running total at ${t.aggregate}+ across all scores.`;
    } else {
      detailB = `You still need ${t.routeAggMarks} more at ${t.threshold}+, and a running total of at least ${t.aggregate}.`;
    }

    options.push({
      label: "Option B",
      headline:
        t.cls === "First"
          ? `${hi} or ${lo} first-class marks, and an aggregate of at least ${t.aggregate}`
          : `${hi} or ${lo} marks of ${t.threshold}+, and an aggregate of at least ${t.aggregate}`,
      detail: detailB,
    });

    return options;
  }

  if (t.routeMarks != null && t.routeMarks > 0) {
    options.push({
      headline: `Need ${t.routeMarks} more mark${t.routeMarks === 1 ? "" : "s"} of ${t.threshold}+`,
      detail:
        remaining > 0
          ? `${remaining} score${remaining === 1 ? "" : "s"} still to enter`
          : undefined,
    });
  }

  if (t.routeMarks === 0 && options.length === 0) {
    options.push({
      headline: "You've hit the mark count",
      detail: "Keep an eye on your running total as the rest come in.",
    });
  }

  if (!options.length && t.note) {
    options.push({ headline: t.note });
  }

  return options;
}

function AimRoutes({
  t,
  remaining,
  showIntro = false,
}: {
  t: TargetResult;
  remaining: number;
  showIntro?: boolean;
}) {
  const options = buildAimOptions(t, remaining);
  if (!options.length) {
    return (
      <p className="text-sm leading-relaxed text-muted">
        Enter scores to see what you need.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {showIntro ? (
        <p className="text-sm leading-relaxed text-night">
          To get a {targetLabel(t.cls)} you could:
        </p>
      ) : null}
      <div
        className={cn(
          "grid gap-4",
          options.length > 1 ? "sm:grid-cols-2 sm:gap-6" : null,
        )}
      >
        {options.map((opt, i) => (
          <AimOption key={opt.label ?? `aim-${i}`} {...opt} />
        ))}
      </div>
    </div>
  );
}

function statusChipClass(status: TargetResult["status"]) {
  if (status === "secured") {
    return "border-status-plan-border bg-status-plan-bg text-status-plan-text";
  }
  if (status === "out_of_reach") {
    return "border-status-check-border bg-status-check-bg text-status-check-text";
  }
  return "border-line bg-lilac text-indigo";
}

export function GradesPanel({
  plan,
  byCode,
}: {
  plan: Plan;
  byCode: Map<string, IndexEntry>;
}) {
  const grades = useGrades();
  const [extraCode, setExtraCode] = useState("");
  const [extraYear, setExtraYear] = useState(1);
  const [extraUnits, setExtraUnits] = useState<0.5 | 1>(1);
  const [extras, setExtras] = useState<
    { code: string; year: number; units: number }[]
  >([]);
  const [target, setTarget] = useState<TargetClass>("First");
  const [routesOpen, setRoutesOpen] = useState(false);
  const routesTitleId = useId();
  const routesCloseRef = useRef<HTMLButtonElement>(null);

  const scheme = schemeForYears(plan.years);

  const courses: GradeCourse[] = useMemo(() => {
    const fromPlan = plan.items.map((i) => ({
      code: i.code,
      year: i.year,
      units: byCode.get(i.code)?.units ?? null,
      mark: grades[i.code] ?? null,
    }));
    const inPlan = new Set(plan.items.map((i) => i.code));
    const extra = extras
      .filter((e) => !inPlan.has(e.code))
      .map((e) => ({
        code: e.code,
        year: e.year,
        units: byCode.get(e.code)?.units ?? e.units,
        mark: grades[e.code] ?? null,
      }));
    return [...fromPlan, ...extra];
  }, [plan.items, extras, byCode, grades]);

  const analysis = useMemo(() => analyse(scheme, courses), [scheme, courses]);
  const selected =
    analysis.targets.find((t) => t.cls === target) ?? analysis.targets[0];
  const selectedNote = selected ? targetStatusNote(selected) : null;
  const aimOptions = selected
    ? buildAimOptions(selected, analysis.remaining)
    : [];
  const canShowRoutes =
    !analysis.final && !!selected && !selectedNote && aimOptions.length > 0;

  useEffect(() => {
    if (!canShowRoutes && routesOpen) setRoutesOpen(false);
  }, [canShowRoutes, routesOpen]);

  useEffect(() => {
    if (!routesOpen) return;
    routesCloseRef.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setRoutesOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [routesOpen]);

  const years = Array.from({ length: plan.years }, (_, i) => i + 1);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-[var(--radius)] border border-line bg-surface p-4 sm:p-6">
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="font-display text-xl text-night">Grade tracker</h2>
            <p className="mt-1 text-sm text-muted">
              Your Degree Plan courses fill this list. Full unit = 2 marks · half
              unit = 1 · Year 1 average counted twice.{" "}
              <a
                href={scheme.url}
                target="_blank"
                rel="noreferrer"
                className="text-violet underline underline-offset-2 hover:text-indigo"
              >
                Official scheme PDF
              </a>
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <span id="grade-target-lead" className="text-sm font-medium text-night">
              Aim for
            </span>
            <TargetClassSegment
              value={target}
              onChange={setTarget}
              labelledBy="grade-target-lead"
            />
          </div>
        </div>

        <div
          className={cn(
            "mt-5 space-y-5 rounded-[var(--radius-inner)] border border-line bg-surface p-4 sm:p-5",
            selected?.status === "out_of_reach" && "note-needs-checking",
            selected?.status === "secured" && "border-status-plan-border bg-status-plan-bg",
          )}
          aria-live="polite"
        >
          {analysis.final ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-display text-2xl tracking-tight text-night">
                  {targetLabel(analysis.final.cls)}
                </p>
                <span className="inline-flex min-h-8 items-center rounded-full border border-line bg-lilac px-3 text-xs font-semibold text-indigo">
                  Final result
                </span>
              </div>
              <p className="text-sm text-muted">
                Based on all {scheme.laterMarks + 2} scores for a {scheme.years}-year degree
                (running total{" "}
                <span className="font-data tabular text-night">
                  {analysis.final.aggregate}
                </span>
                ).
              </p>
              {selected && selected.cls !== analysis.final.cls && (
                <p className="text-sm text-muted">
                  Checking {targetLabel(selected.cls)}: {statusLabel(selected.status)}.
                  {selected.note ? ` ${selected.note}` : null}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="font-display text-2xl tracking-tight text-night">
                  {targetLabel(target)}
                </p>
                {selected && (
                  <span
                    className={cn(
                      "inline-flex min-h-8 items-center rounded-full border px-3 text-xs font-semibold",
                      statusChipClass(selected.status),
                    )}
                  >
                    {statusLabel(selected.status)}
                  </span>
                )}
              </div>

              {analysis.known.length > 0 ? (
                <p className="text-sm leading-relaxed text-muted">
                  Average so far{" "}
                  <span className="font-data tabular font-semibold text-night">
                    {analysis.average!.toFixed(1)}
                  </span>
                  {analysis.projected
                    ? `, on pace for a ${targetLabel(analysis.projected)}.`
                    : "."}
                </p>
              ) : (
                <p className="text-sm leading-relaxed text-muted">
                  Enter scores below to see how you're doing.
                </p>
              )}

              {canShowRoutes ? (
                <button
                  type="button"
                  className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-violet underline-offset-4 hover:text-indigo hover:underline"
                  onClick={() => setRoutesOpen(true)}
                >
                  How to get a {targetLabel(selected.cls)}
                </button>
              ) : null}

              {selectedNote ? (
                <p className="mt-3 text-sm leading-relaxed text-muted">
                  {selectedNote}
                </p>
              ) : null}
            </div>
          )}

          {(() => {
            const total = scheme.laterMarks + 2;
            const filled = analysis.known.length;
            const laterFilled = Math.max(0, filled - (analysis.fya != null ? 2 : 0));
            const laterLeft = Math.max(0, scheme.laterMarks - laterFilled);
            const pct = total > 0 ? Math.min(100, Math.round((filled / total) * 100)) : 0;
            return (
              <div className="space-y-3 border-t border-line pt-4">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <p className="text-xs font-medium text-muted">
                      Progress · {scheme.years}-year degree
                    </p>
                    <p className="font-data text-sm tabular text-muted">
                      <span className="font-semibold text-night">{filled}</span>
                      {" / "}
                      {total}
                      <span aria-hidden className="mx-1.5">
                        ·
                      </span>
                      {analysis.remaining === 0
                        ? "All scores in"
                        : `${analysis.remaining} still to enter`}
                    </p>
                  </div>
                  <div
                    className="unit-meter w-full"
                    data-state={filled >= total ? "full" : undefined}
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={total}
                    aria-valuenow={filled}
                    aria-label={`Classification scores entered: ${filled} of ${total}`}
                  >
                    <span
                      style={{ width: `${pct}%` }}
                      className="motion-reduce:transition-none"
                    />
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="min-w-0 rounded-[calc(var(--radius-inner)-4px)] border border-line bg-lilac-deep p-3">
                    <p className="text-xs font-medium text-muted">Year 1 average</p>
                    <p
                      className={cn(
                        "mt-1.5 font-data text-xl tabular font-semibold leading-none",
                        analysis.fya != null ? "text-night" : "text-muted",
                      )}
                    >
                      {analysis.fya != null ? analysis.fya : "Not yet"}
                    </p>
                    <p className="mt-2 text-sm leading-snug text-muted">
                      {analysis.fya != null
                        ? `Best 6 of Year 1, counted twice (2 of ${total}).`
                        : `Best 6 of Year 1, counted twice (2 of ${total}). Enter Year 1 scores to unlock.`}
                    </p>
                  </div>
                  <div className="min-w-0 rounded-[calc(var(--radius-inner)-4px)] border border-line bg-lilac-deep p-3">
                    <p className="text-xs font-medium text-muted">
                      Scores from Years 2 to {scheme.years}
                    </p>
                    <p className="mt-1.5 font-data text-xl tabular font-semibold leading-none text-night">
                      {laterFilled}
                      <span className="text-sm font-medium text-muted">
                        {" "}
                        / {scheme.laterMarks}
                      </span>
                    </p>
                    <p className="mt-2 text-sm leading-snug text-muted">
                      {laterLeft === 0
                        ? "All later-year scores entered."
                        : `${laterLeft} left. Full unit = 2 scores.`}
                    </p>
                  </div>
                </div>
              </div>
            );
          })()}

        </div>

        {analysis.warnings.length > 0 && (
          <ul className="mt-3 space-y-1.5 text-sm leading-snug text-muted">
            {analysis.warnings.map((w) => (
              <li key={w} className="pl-0">
                {w}
              </li>
            ))}
          </ul>
        )}
      </div>

      {courses.length === 0 ? (
        <p className="rounded-[var(--radius)] border border-dashed border-line p-6 text-center text-sm text-muted">
          Nothing here yet. Add courses in Degree Plan and they show up here on
          their own. Or type a code below to track a mark.
        </p>
      ) : (
        <div className="space-y-4">
          {years.map((y) => {
            const rows = courses
              .filter((c) => c.year === y)
              .sort((a, b) => a.code.localeCompare(b.code));
            return (
              <section
                key={y}
                className="overflow-x-auto rounded-[var(--radius)] border border-line bg-surface"
              >
                <div className="flex flex-col gap-1 border-b border-line bg-lilac-deep px-3 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-2">
                  <h3 className="font-display text-base text-night">Year {y}</h3>
                  {y === 1 ? (
                    <p className="text-sm text-muted">
                      {analysis.fya != null ? (
                        <>
                          Year 1 average{" "}
                          <span className="font-data tabular font-semibold text-night">
                            {analysis.fya}
                          </span>
                          {" "}
                          (best 6 of 9, counted twice). That is{" "}
                          <span className="font-semibold text-night">2 of {scheme.laterMarks + 2}</span>{" "}
                          scores overall.
                        </>
                      ) : (
                        <>
                          Average the best 6 of your 9 Year 1 scores and count that
                          twice. It makes up 2 of {scheme.laterMarks + 2} scores
                          overall.
                        </>
                      )}
                    </p>
                  ) : null}
                </div>
                {rows.length === 0 ? (
                  <p className="px-3 py-4 text-sm text-muted">No courses planned for this year.</p>
                ) : (
                  <table className="w-full min-w-[40rem] table-fixed text-left text-sm">
                    <colgroup>
                      <col className="w-[6.5rem]" />
                      <col />
                      <col className="w-[5.5rem]" />
                      <col className="w-[6.5rem]" />
                      <col className="w-[7.5rem]" />
                    </colgroup>
                    <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
                      <tr>
                        <th className="px-3 py-2.5 font-semibold">Code</th>
                        <th className="px-3 py-2.5 font-semibold">Course</th>
                        <th className="px-3 py-2.5 text-right font-semibold">Units</th>
                        <th
                          className="px-3 py-2.5 text-right font-semibold"
                          title={
                            y === 1
                              ? "Weight in the Year 1 average pool (not a direct share of the final 18 marks)"
                              : "How many classification marks this course contributes (full unit = 2, half = 1)"
                          }
                        >
                          {y === 1 ? "Avg weight" : "Marks"}
                        </th>
                        <th className="px-3 py-2.5 text-right font-semibold">Your score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((c) => {
                        const entry = byCode.get(c.code);
                        const classMarks = marksFor(c.units);
                        const usedInFya =
                          y === 1 && analysis.fyaMarks
                            ? analysis.fyaMarks.some((m) => m.code === c.code && m.used)
                            : null;
                        return (
                          <tr key={`${c.year}-${c.code}`} className="border-b border-line last:border-0">
                            <td className="px-3 py-2.5 align-middle">
                              <span className="chip-code px-1.5 py-0.5 text-xs tabular">
                                {c.code}
                              </span>
                            </td>
                            <td className="truncate px-3 py-2.5 align-middle text-muted">
                              {entry?.title ?? "-"}
                              {usedInFya === false ? (
                                <span className="ml-2 text-xs text-muted">(not in best 6)</span>
                              ) : null}
                            </td>
                            <td className="px-3 py-2.5 text-right align-middle tabular text-muted">
                              {unitLabel(c.units)}
                            </td>
                            <td className="px-3 py-2.5 text-right align-middle tabular text-muted">
                              {classMarks || "-"}
                            </td>
                            <td className="px-3 py-2.5 text-right align-middle">
                              <input
                                type="number"
                                inputMode="decimal"
                                min={0}
                                max={100}
                                step={0.5}
                                className={cn(
                                  "field-input ml-auto w-full max-w-[6.5rem] text-right tabular",
                                  c.mark != null && c.mark >= 70 && "border-status-plan-border",
                                  c.mark != null && c.mark < 40 && "border-danger",
                                )}
                                aria-label={`Mark for ${c.code}`}
                                placeholder="-"
                                value={c.mark ?? ""}
                                disabled={classMarks === 0}
                                onChange={(e) => {
                                  const parsed = parseMarkInput(e.target.value);
                                  if (e.target.value.trim() === "") {
                                    gradeActions.set(c.code, null);
                                    return;
                                  }
                                  if (parsed == null) return;
                                  gradeActions.set(c.code, parsed);
                                }}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </section>
            );
          })}
        </div>
      )}

      <form
        className="flex flex-col gap-3 rounded-[var(--radius)] border border-line bg-surface p-4 sm:max-w-xl"
        onSubmit={(e) => {
          e.preventDefault();
          const code = extraCode.trim().toUpperCase();
          if (!code) return;
          if (!isValidCourseCode(code)) {
            toast.error("Enter a valid course code");
            return;
          }
          setExtras((prev) => {
            const rest = prev.filter((x) => x.code !== code);
            return [...rest, { code, year: extraYear, units: extraUnits }];
          });
          setExtraCode("");
          toast.success(`Added ${code} to tracker`);
        }}
      >
        <p className="text-sm font-medium text-night">Add a course not in your plan</p>
        <div className="flex flex-wrap gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="grades-extra-code" className="text-xs text-muted">
              Code
            </label>
            <input
              id="grades-extra-code"
              className="field-input w-36"
              value={extraCode}
              onChange={(e) => setExtraCode(e.target.value)}
              placeholder="e.g. EC201"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span id="grades-extra-year-label" className="text-xs text-muted">
              Year
            </span>
            <MenuSelect
              id="grades-extra-year"
              labelledBy="grades-extra-year-label"
              className="w-28"
              value={extraYear}
              onChange={setExtraYear}
              options={years.map((y) => ({ value: y, label: String(y) }))}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span id="grades-extra-units-label" className="text-xs text-muted">
              Units
            </span>
            <MenuSelect
              id="grades-extra-units"
              labelledBy="grades-extra-units-label"
              className="w-32"
              value={extraUnits}
              onChange={setExtraUnits}
              options={[
                { value: 1 as const, label: "1.0", description: "Full unit" },
                { value: 0.5 as const, label: "0.5", description: "Half unit" },
              ]}
            />
          </div>
          <div className="flex flex-col justify-end gap-1">
            <button type="submit" className="btn-dark px-4 text-sm">
              Add Row
            </button>
          </div>
        </div>
      </form>

      {routesOpen && selected && canShowRoutes ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
          role="presentation"
        >
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Close dialog"
            onClick={() => setRoutesOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={routesTitleId}
            className="relative z-10 max-h-[min(85vh,40rem)] w-full max-w-lg overflow-y-auto rounded-[var(--radius)] border border-line bg-surface p-5 shadow-[0_8px_24px_rgba(27,22,64,0.07)] sm:p-6"
          >
            <div className="flex items-start justify-between gap-3">
              <h2
                id={routesTitleId}
                className="font-display text-lg font-bold text-night"
              >
                How to get a {targetLabel(selected.cls)}
              </h2>
              <button
                ref={routesCloseRef}
                type="button"
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-muted hover:bg-lilac hover:text-night"
                aria-label="Close"
                onClick={() => setRoutesOpen(false)}
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>
            <p className="mt-2 text-sm text-muted">
              From the LSE Calendar classification rules for a {scheme.years}-year
              BA/BSc. Either route counts.
            </p>
            <div className="mt-4">
              <AimRoutes t={selected} remaining={analysis.remaining} />
            </div>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                className="btn-ghost min-h-12 px-5"
                onClick={() => setRoutesOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
