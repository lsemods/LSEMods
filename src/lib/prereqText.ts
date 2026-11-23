/**
 * Turn a course guide's prerequisite wording into an AND/OR tree of course codes — the same rules the
 * Python scraper uses (scrapers/build_graph.py):
 *  - "and" binds tighter than "or"; brackets group;
 *  - a comma takes the next and/or in its list ("A, B or C" = "A or B or C");
 *  - sentences that exclude courses ("must not have taken X") are skipped, as their codes aren't prerequisites.
 * Wording with no course codes ("A-level Mathematics") gives no tree.
 */
import { canonicalCode } from "./courseAliases";
import type { Req } from "./types";

const CODE = "[A-Z]{2,3}\\d[A-Z0-9]{2,4}";
const TOKEN = new RegExp(`\\(|\\)|,|\\b(?:[Aa]nd|[Oo]r|AND|OR)\\b|\\b${CODE}\\b`, "g");
const NEGATION = /\b(must not|cannot|can not|may not|not have|not be|unless|except)\b/i;

type Tok = "(" | ")" | "," | "and" | "or" | { code: string };

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const t = m[0];
    if (t === "(" || t === ")" || t === ",") out.push(t);
    else if (/^(and|or)$/i.test(t)) out.push(t.toLowerCase() as "and" | "or");
    else out.push({ code: canonicalCode(t) });
  }
  // a comma takes the next and/or at the same bracket depth
  return out.map((t, i) => {
    if (t !== ",") return t;
    let depth = 0;
    for (const u of out.slice(i + 1)) {
      if (u === "(") depth++;
      else if (u === ")") {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && (u === "and" || u === "or")) return u;
    }
    return "and";
  });
}

function mk(type: "and" | "or", parts: (Req | null)[]): Req | null {
  const flat: Req[] = [];
  for (const p of parts) {
    if (!p) continue;
    if (p.type === type) flat.push(...p.children);
    else flat.push(p);
  }
  if (flat.length === 0) return null;
  if (flat.length === 1) return flat[0];
  return { type, children: flat };
}

function parseTokens(toks: Tok[]): Req | null {
  let i = 0;
  const peek = () => toks[i];
  const isCode = (t: Tok | undefined): t is { code: string } => typeof t === "object";
  function factor(): Req | null {
    const t = peek();
    if (isCode(t)) {
      i++;
      return { type: "course", code: t.code };
    }
    if (t === "(") {
      i++;
      const n = expr();
      if (peek() === ")") i++;
      return n;
    }
    return null;
  }
  function term(): Req | null {
    const parts: (Req | null)[] = [];
    for (;;) {
      parts.push(factor());
      const t = peek();
      if (t === "and") {
        i++;
        continue;
      }
      if (isCode(t) || t === "(") continue; // two operands side by side: treat as AND
      break;
    }
    return mk("and", parts);
  }
  function expr(): Req | null {
    const parts: (Req | null)[] = [term()];
    while (peek() === "or") {
      i++;
      parts.push(term());
    }
    return mk("or", parts);
  }
  const nodes: (Req | null)[] = [];
  while (i < toks.length) {
    const before = i;
    nodes.push(expr());
    if (i < toks.length && (peek() === ")" || peek() === "or" || peek() === "and" || i === before)) i++; // stray token
  }
  return mk("and", nodes);
}

/** The prerequisite tree in a course guide's wording, or null if it names no courses. */
export function parsePrerequisites(text: string | null | undefined): Req | null {
  if (!text) return null;
  const nodes: (Req | null)[] = [];
  for (const sentence of text.split(/(?<=[.;])\s+/)) {
    if (NEGATION.test(sentence)) continue;
    const toks = tokenize(sentence);
    if (toks.some((t) => typeof t === "object")) nodes.push(parseTokens(toks));
  }
  return mk("and", nodes);
}
