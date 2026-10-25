/**
 * Residual check: the last look at text after masking and before anything
 * leaves for a model. Detection can miss a value (an unusual format, a name
 * the NLP model does not know); this catches the shapes that are almost
 * never safe to send. A hit refuses the request: nothing is sent, nothing is
 * charged. It reports kinds and counts only, never the values or where they
 * are, so the refusal and the ledger hold no personal data.
 *
 * Placeholders (<TYPE_n>, <C_TYPE_n>) and [CARD REMOVED] are removed before
 * checking, and so are ISO dates and times, which look like digit runs.
 */
export const RESIDUAL_CHECKS = ["digits", "spaced_digits", "intl_phone", "email", "titled_name"] as const;
export type ResidualKind = (typeof RESIDUAL_CHECKS)[number];
export type ResidualPolicy = {
  enabled: boolean;
  checks: readonly ResidualKind[];
  /** The fewest digits that count as an identifier in "digits" and "spaced_digits". */
  minDigits: number;
};
export type ResidualHit = { kind: ResidualKind; count: number };

export const DEFAULT_RESIDUAL: ResidualPolicy = { enabled: true, checks: RESIDUAL_CHECKS, minDigits: 9 };

const PLACEHOLDERS = /<\s*[A-Za-z][A-Za-z_]*?_\d+\s*>|\[CARD REMOVED\]/g;
/** 2024-01-05, 2024-01-05T12:30, 2024-01-05 12:30:00.123Z */
const ISO_DATE_TIME = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;

const digitCount = (s: string): number => s.replace(/\D/g, "").length;

/** How many matches of `re` in `text` hold at least `min` digits. */
function countRuns(text: string, re: RegExp, min: number): number {
  let n = 0;
  for (const m of text.matchAll(re)) if (digitCount(m[0]) >= min) n++;
  return n;
}

const CHECKS: Record<ResidualKind, (text: string, minDigits: number) => number> = {
  // 991200345678, 12-3456-7890123-00, 12/0034/5678: digits joined by nothing, "-" or "/" ("." is left out so 1234567.89 is an amount)
  digits: (t, min) => countRuns(t, /\d+(?:[-/]\d+)*/g, min),
  // 2345 6789 0123, 4111 1111 1111 1111, 98201 44907: groups of 3 to 5 digits split by single spaces
  spaced_digits: (t, min) => countRuns(t, /\b\d{3,5}(?: \d{3,5})+\b/g, Math.max(min, 10)),
  // +1 415 555 0132, +91 (98201) 44907
  intl_phone: (t) => countRuns(t, /\+\d[\d ()-]{6,}\d/g, 8),
  email: (t) => [...t.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)].length,
  // MR AB SAMPLEPERSON, Mrs Samplename, Dr. Grant, Shri Ravi: a title followed by a capitalised word that is not a placeholder.
  // A line break may separate them only when nothing was masked between ("MR\nSAMPLEPERSON"). After a placeholder (" # "),
  // only spaces or tabs: "Dr. <C_PERSON_1> Grant" is refused (a leftover surname); "Dr. <C_PERSON_2>" + next line's heading is not.
  titled_name: (t) => [...t.matchAll(/\b(?:Mr|MR|Mrs|MRS|Miss|MISS|Dr|DR|Shri|SHRI|Smt|SMT|Ms\.|MS\.)\.?(?:(?:[ \t]+#)+[ \t]+|\s+)[A-Z][A-Za-z'-]*/g)].length,
};

/** Kinds and counts of what looks like personal data in already-masked texts; empty when the policy is off or nothing is found. */
export function residualHits(texts: readonly string[], policy: ResidualPolicy): ResidualHit[] {
  if (!policy.enabled) return [];
  const counts = new Map<ResidualKind, number>();
  for (const text of texts) {
    // A placeholder becomes a neutral non-letter mark, not a space: as a space, "Dr. <C_PERSON_2>" followed by a
    // line starting with a capital ("Diagnosis") read as the titled name "Dr. Diagnosis". " # " still splits digit runs.
    const clean = text.replace(PLACEHOLDERS, " # ").replace(ISO_DATE_TIME, " ");
    for (const kind of policy.checks) {
      const n = CHECKS[kind](clean, policy.minDigits);
      if (n > 0) counts.set(kind, (counts.get(kind) ?? 0) + n);
    }
  }
  return RESIDUAL_CHECKS.filter((k) => counts.has(k)).map((kind) => ({ kind, count: counts.get(kind)! }));
}

/** Parse a comma-separated --residual-checks value: check names or "all". */
export function parseResidualChecks(value: string): ResidualKind[] {
  const v = value.trim().toLowerCase();
  if (v === "all") return [...RESIDUAL_CHECKS];
  const out: ResidualKind[] = [];
  for (const part of v.split(",").map((p) => p.trim()).filter(Boolean)) {
    if (!(RESIDUAL_CHECKS as readonly string[]).includes(part)) throw new Error(`--residual-checks: unknown check ${part}; use all or ${RESIDUAL_CHECKS.join(",")}`);
    if (!out.includes(part as ResidualKind)) out.push(part as ResidualKind);
  }
  if (out.length === 0) throw new Error("--residual-checks: name at least one check, or turn the guard off with --residual-guard off");
  return out;
}

/** The refusal message: kinds and counts only. */
export function residualMessage(hits: readonly ResidualHit[]): string {
  const total = hits.reduce((n, h) => n + h.count, 0);
  const kinds = hits.map((h) => `${h.kind} ${h.count}`).join(", ");
  return `after masking, the request still holds ${total} value(s) that look like personal data (${kinds}); nothing was sent to a model and you were not charged. Mask them first, or ask the operator to review --residual-checks`;
}
