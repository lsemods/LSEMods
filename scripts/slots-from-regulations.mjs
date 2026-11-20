#!/usr/bin/env node
/**
 * Replace a degree year's choice slots in public/data/programmes.json with the papers from the scraped
 * official regulations (public/data/programmes/<id>.json), so each paper is its own slot with its own
 * unit target and course list. Compulsory, dissertation and LSE100 slots in that year are kept.
 *
 * Usage:
 *   node scripts/slots-from-regulations.mjs "BSc Economics" 3
 *   node scripts/slots-from-regulations.mjs "BSc Economics" 3 --dry-run
 *
 * Only papers with a stated unit amount ("Courses to the value of 1.0 unit(s) …") are converted;
 * anything else is left for a person to check. Re-run after each yearly data refresh.
 *
 * A combined paper ("Papers 9 & 10: courses to the value of 2.0 units …") becomes one slot per paper, each
 * with an equal share, so every paper is its own choice. Either/or rules from the programme page that the
 * scraped wording flattens (e.g. "EITHER FM214 + FM215 OR one other course") come from
 * scripts/slot-overrides.json.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [degreeName, yearArg, ...flags] = process.argv.slice(2);
const dryRun = flags.includes("--dry-run");
if (!degreeName || !yearArg) {
  console.error('Usage: node scripts/slots-from-regulations.mjs "<Degree name>" <year> [--dry-run]');
  process.exit(1);
}
const year = Number(yearArg);

const slug = (n) => n.replace(/\(.*?\)/g, " ").replace(/\b(in|of)\b/gi, " ").replace(/[^A-Za-z0-9]+/g, "");
const progPath = path.join(root, "public", "data", "programmes.json");
const programmes = JSON.parse(await readFile(progPath, "utf8"));
const prog = programmes.find((p) => p.name === degreeName);
if (!prog) throw new Error(`No programme named "${degreeName}" in programmes.json`);

const index = JSON.parse(await readFile(path.join(root, "public", "data", "programmes", "index.json"), "utf8"));
const wanted = `2026-${slug(degreeName)}`.toLowerCase();
const entry = index.find((e) => String(e.id).toLowerCase() === wanted);
if (!entry) throw new Error(`No regulations file for "${degreeName}" (looked for ${wanted})`);
const regs = JSON.parse(await readFile(path.join(root, "public", "data", "programmes", `${entry.id}.json`), "utf8"));
const regYear = regs.years.find((y) => y.year === year);
if (!regYear) throw new Error(`Regulations have no Year ${year}`);

const target = prog.years.find((y) => y.year === year);
if (!target) throw new Error(`programmes.json has no Year ${year} for ${degreeName}`);

const overridesAll = JSON.parse(await readFile(path.join(root, "scripts", "slot-overrides.json"), "utf8"));
const overrides = overridesAll[degreeName]?.[String(year)] ?? {};

/** "Papers 9 & 10" / "Papers 9, 10 and 11" → [9, 10, 11]; a single paper → null */
function paperNumbers(label) {
  const m = label.match(/^Papers\s+(\d+(?:\s*(?:,|&|and)\s*\d+)+)$/i);
  return m ? m[1].split(/\s*(?:,|&|and)\s*/i).map(Number) : null;
}

const KEEP = new Set(["compulsory", "dissertation", "LSE100"]);
const kept = target.slots.filter((s) => KEEP.has(s.ruleType));
let order = Math.max(0, ...kept.map((s) => s.order));
const converted = [];
const skipped = [];
for (const p of regYear.papers) {
  if (!p.choice || p.unitsNeeded == null || p.compulsory.length) {
    if (p.choice) skipped.push(p.label);
    continue;
  }
  const codes = new Set(p.options.map((c) => c.toUpperCase()));
  for (const name of p.lists) for (const c of regs.lists[name] ?? []) codes.add(String(c).toUpperCase());
  const wording = p.lines.join(" ").replace(/\s+/g, " ").trim();
  const clip = (t) => (t.length > 420 ? t.slice(0, 417) + "…" : t);
  const numbers = paperNumbers(p.label);
  const share = numbers ? p.unitsNeeded / numbers.length : null;
  // Split "Papers 9 & 10 (2.0 units)" into Paper 9 and Paper 10 (1.0 unit each), when the share is a whole half unit
  const parts =
    numbers && share >= 0.5 && Math.abs(share * 2 - Math.round(share * 2)) < 1e-9
      ? numbers.map((n) => ({
          label: `Paper ${n}`,
          units: share,
          text: `Paper ${n}: ${clip(wording.replace(/value of\s*[\d.]+\s*unit/i, `value of ${share.toFixed(1)} unit`))} (${p.label} together: ${p.unitsNeeded.toFixed(1)} units.)`,
        }))
      : [{ label: p.label, units: p.unitsNeeded, text: `${p.label}: ${clip(wording)}` }];
  for (const part of parts) {
    const slot = {
      order: ++order,
      ruleType: "choose_units_from_list",
      units: part.units,
      courses: [...codes].sort(),
      text: part.text,
      confidence: "REGULATIONS",
      issue: null,
      countsInYearTotal: true,
      ruleTypeRaw: `choose_units_from_list (from ${entry.id} regulations)`,
      unitsRaw: String(part.units),
    };
    const extra = overrides[part.label];
    if (extra?.either) {
      slot.either = extra.either;
      slot.ruleTypeRaw += "; either/or from scripts/slot-overrides.json";
      if (extra.source) slot.text += ` ${extra.source}`;
    }
    converted.push(slot);
  }
}
if (!converted.length) throw new Error("Nothing to convert: no papers with a stated unit amount");

const before = target.slots.filter((s) => !KEEP.has(s.ruleType)).map((s) => `${s.ruleType} ${s.units}u`);
console.log(`${degreeName}, Year ${year}: replacing [${before.join(", ")}] with:`);
for (const s of converted) console.log(`  ${s.text.slice(0, 70)}… → ${s.units}u from ${s.courses.length} courses`);
if (skipped.length) console.log(`  left for checking (no stated unit amount or has compulsory parts): ${skipped.join(", ")}`);

if (!dryRun) {
  target.slots = [...kept, ...converted];
  // The data file writes every unit value with a decimal point ("units": 1.0); keep that style so the
  // diff only shows real changes.
  const json = JSON.stringify(programmes, null, 2).replace(/("units": )(-?\d+)(,?)$/gm, "$1$2.0$3");
  await writeFile(progPath, json + "\n");
  console.log(`Wrote ${path.relative(root, progPath)}`);
}
