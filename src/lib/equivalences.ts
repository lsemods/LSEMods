/**
 * Course relationships used on top of each course guide's own prerequisite wording.
 * Add a line here when LSE splits a course, or when a fuller course covers a lighter one.
 *
 * - A split course equals its parts, both ways: all the parts count as the whole, and the whole counts as
 *   each part (ST102 = ST109 + ST110).
 * - "Covers" is one way only: the fuller course counts as the lighter one, never the reverse.
 */
export const SPLITS: { whole: string; parts: string[]; why: string }[] = [
  { whole: "ST102", parts: ["ST109", "ST110"], why: "ST107’s course guide calls ST109 and ST110 ST102’s “respective half-units”" },
  { whole: "MA103", parts: ["MA102", "MA104"], why: "degree regulations replaced MA103 with MA102 and MA104" },
];

export const COVERS: { fuller: string; lighter: string; why: string }[] = [
  { fuller: "ST102", lighter: "ST107", why: "ST107 covers ST102’s material in less depth" },
  { fuller: "MA108", lighter: "MA107", why: "MA107 covers MA108’s material in less depth" },
];

/** Everything a set of courses counts as, and how each extra course was reached (ST107 ← "ST102"). */
export function withEquivalents(have: Iterable<string>): { all: Set<string>; via: Map<string, string> } {
  const all = new Set(have);
  const via = new Map<string, string>();
  const add = (code: string, from: string) => {
    if (all.has(code)) return false;
    all.add(code);
    via.set(code, from);
    return true;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of SPLITS) {
      if (s.parts.every((p) => all.has(p))) changed = add(s.whole, s.parts.join(" + ")) || changed;
      if (all.has(s.whole)) for (const p of s.parts) changed = add(p, s.whole) || changed;
    }
    for (const c of COVERS) if (all.has(c.fuller)) changed = add(c.lighter, c.fuller) || changed;
  }
  return { all, via };
}
