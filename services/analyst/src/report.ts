/**
 * From an Analysis to what people and the model read: findings ranked by money impact, a period-by-period scorecard,
 * the evidence pack (text sized to a character budget) and the check of numbers in a model's answer.
 */
import type { Analysis, Pair, Ref, Status } from "./analyze.ts";

export type Finding = { id: string; type: "variance" | "unmatched" | "duplicates" | "outliers" | "gaps"; impact: number; title: string; lines: string[]; rows: Ref[] };
export type Scorecard = { periods: string[]; rows: { pair: string; mode: string; cells: Record<string, { status: Status; variance: number; gap: number | null; deviation: number | null; ratio: number | null }> }[] };

const MEASURE_LABEL: Record<string, string> = { net: "signed amounts (net)", inflows: "money in only (positive amounts)", outflows: "money out only (negative amounts, as positive)", abs: "absolute amounts" };
const money = (n: number): string => (n < 0 ? "-" : "") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (p: number | null): string => (p === null ? "n/a" : `${(p * 100).toFixed(1)}%`);
export const periodLabel = (period: string, unit: Analysis["periodUnit"]): string => (unit === "month" ? period.slice(0, 7) : unit === "quarter" ? `${period.slice(0, 4)}-Q${Math.floor((+period.slice(5, 7) - 1) / 3) + 1}` : `wk ${period}`);

/** Plain-language meaning of "in A but not in B" for common pairs of file kinds. */
function gapMeaning(ka: string, kb: string, byRef: boolean): [string, string] {
  const table: Record<string, [string, string]> = {
    "collections>deposits": ["collected but no matching bank deposit", "deposited with no matching collection record"],
    "production>collections": [byRef ? "charged with no payment received" : "charged with no matching collection", "paid with no matching charge"],
    "billing>collections": ["billed with no payment received", "paid with no matching bill"],
    "deposits>ledger": ["deposited but not recorded in the ledger", "recorded in the ledger with no matching deposit"],
    "income>deposits": ["income recorded with no matching deposit", "deposited with no matching income entry"],
    "ledger>tax": ["in the ledger, not found on the tax side", "on the tax side, not found in the ledger"],
  };
  return table[`${ka}>${kb}`] ?? [`in ${ka} with no match in ${kb}`, `in ${kb} with no match in ${ka}`];
}

export function findingsOf(an: Analysis, maxFindings: number): Finding[] {
  const out: Finding[] = [];
  const u = an.periodUnit, st = an.settings;
  const kind = (f: string) => an.files.find((x) => x.name === f)?.kind ?? "other";
  for (const p of an.pairs) {
    const last = p.tie[p.tie.length - 1];
    if (p.run) {
      const r = p.run;
      const what = p.mode === "ratio" ? `${p.b} fell below its usual share of ${p.a}` : `${p.b} does not tie to ${p.a}`;
      out.push({
        id: `var:${p.label}`, type: "variance", impact: Math.abs(r.cumulativeGap),
        title: `${what}: ${money(r.cumulativeGap)} versus expected over ${r.periods} ${u}${r.periods === 1 ? "" : "s"} since ${periodLabel(r.start, u)}${r.ongoing ? " (still ongoing)" : `, ended ${periodLabel(r.end, u)}`}`,
        lines: [
          p.mode === "ratio"
            ? `usual ${p.b}/${p.a} ratio before it: ${pct(r.baseline)}; latest ${u}: ${pct(r.latestRatio)}`
            : `baseline before it: ${r.baseline === null ? "no earlier periods" : `${pct(r.baseline)} average difference over ${r.baselinePeriods} ${u}(s)`}`,
          r.periods > 1 ? `change per ${u} during the run: ${money(r.perPeriodChange)} (negative = shortfall growing)` : "",
          last ? `latest ${u} ${periodLabel(last.period, u)}: ${p.a} ${money(last.a)}, ${p.b} ${money(last.b)}, expected ${last.expected === null ? "n/a" : money(last.expected)}` : "",
        ].filter(Boolean),
        rows: [],
      });
    }
    const m = p.match;
    if (m?.informative) {
      const [aMeans, bMeans] = gapMeaning(kind(p.a), kind(p.b), m.by === "reference");
      for (const [side, x, means] of [["A", m.unmatchedA, aMeans], ["B", m.unmatchedB, bMeans]] as const) {
        // By reference, only aged rows count for the earlier file (recent ones may simply not be due yet).
        const amount = m.by === "reference" && side === "A" ? x.agedAmount : x.amount;
        const count = m.by === "reference" && side === "A" ? x.aged : x.count;
        if (!count || Math.abs(amount) <= st.varianceAmount) continue;
        const worst = Object.entries(x.byPeriod).sort((q, w) => Math.abs(w[1]) - Math.abs(q[1])).slice(0, 3).map(([k, v]) => `${periodLabel(k, u)} ${money(v)}`).join(", ");
        out.push({
          id: `unm${side}:${p.label}`, type: "unmatched", impact: Math.abs(amount),
          title: `${count} rows ${means}${m.by === "reference" && side === "A" ? ` after ${st.agingDays} days` : ""}: ${money(amount)} (${p.label})`,
          lines: [
            m.by === "reference" ? `matched by reference column; ${Math.round((side === "A" ? m.rateA : m.rateB) * 100)}% of ${side === "A" ? p.a : p.b} rows have their reference in the other file`
              : `matched by amount (within ${st.amountTolerance}) and date (within ${st.dateWindowDays} days), ${m.mode}; ${Math.round((side === "A" ? m.rateA : m.rateB) * 100)}% of ${side === "A" ? p.a : p.b} rows matched`,
            `${x.count} unmatched in total (${money(x.amount)}); ${x.aged} older than ${st.agingDays} days at the last date in ${p.b}`,
            `largest ${u}s: ${worst || "n/a"}`,
            x.byParty.length && x.partyUseful ? `by party (share of this gap vs share of all ${side === "A" ? p.a : p.b} amounts): ${x.byParty.map((q) => `${q.party} ${money(q.amount)} = ${Math.round(q.share * 100)}% vs ${Math.round(q.normalShare * 100)}%${q.normalShare > 0 && q.share / q.normalShare >= 1.5 ? ` (${(q.share / q.normalShare).toFixed(1)}× its normal share)` : ""}`).join("; ")}` : "",
          ].filter(Boolean),
          rows: x.top,
        });
      }
    }
  }
  for (const f of an.files) {
    if (f.duplicates.groups) out.push({
      id: `dup:${f.name}`, type: "duplicates", impact: Math.abs(f.duplicates.extraAmount),
      title: `${f.name}: ${f.duplicates.extraRows} possible duplicate rows (same date, amount, party/reference), extra ${money(f.duplicates.extraAmount)}`,
      lines: [`${f.duplicates.groups} group(s)`], rows: f.duplicates.top,
    });
    if (f.outliers.length) out.push({ id: `out:${f.name}`, type: "outliers", impact: 0, title: `${f.name}: ${f.outliers.length} unusually large amount(s) (over 10× the typical row)`, lines: [], rows: f.outliers });
    if (f.gaps.length) out.push({
      id: `gap:${f.name}`, type: "gaps", impact: 0,
      title: `${f.name}: no rows in ${f.gaps.length} ${u}(s) inside its date range: ${f.gaps.slice(0, 6).map((g) => periodLabel(g, u)).join(", ")}${f.gaps.length > 6 ? " …" : ""}`,
      lines: [], rows: [],
    });
  }
  return out.sort((x, y) => y.impact - x.impact).slice(0, maxFindings);
}

export function scorecardOf(an: Analysis): Scorecard {
  const periods = [...new Set(an.pairs.flatMap((p) => p.tie.map((t) => t.period)))].sort();
  return { periods, rows: an.pairs.map((p: Pair) => ({ pair: p.label, mode: p.mode, cells: Object.fromEntries(p.tie.map((t) => [t.period, { status: t.status, variance: t.variance, gap: t.gap, deviation: t.deviation, ratio: t.ratio }])) })) };
}

const refLine = (r: Ref): string => `  row ${r.row} of ${r.file}: ${r.date} ${money(r.value)}${r.party ? ` party ${r.party}` : ""}${r.reference ? ` ref ${r.reference}` : ""}`;

export type Evidence = { text: string; chars: number; budget: number; periodsShown: number; periodsTotal: number; findingsShown: number; findingsTotal: number; rowsPerFinding: number };

/**
 * The evidence pack for the model, within `budget` characters. It never truncates silently: it narrows in steps
 * (fewer periods per table, fewer example rows, fewer findings) and says what it left out; if even the file list and
 * flow do not fit, it refuses.
 */
export function evidenceOf(an: Analysis, findings: Finding[], budget: number, rowsPerFinding: number): Evidence {
  const u = an.periodUnit, st = an.settings;
  const head = [
    "DATA ANALYSIS (computed by code over every row of every file; all numbers are exact)",
    "Files:",
    ...an.files.map((f) => `- ${f.name}: ${f.kind}, ${f.rows} rows (${f.valued} used, ${f.skipped} without a readable date or amount), ${f.from ?? "?"} to ${f.to ?? "?"}, counting ${MEASURE_LABEL[f.measure]}`),
    an.pairs.length ? `Flow (earlier stage → later stage): ${[...new Set(an.pairs.flatMap((p) => [p.a, p.b]))].join(" → ")}` : "Single file: no cross-file flow.",
    `How pairs are judged per ${u}: "tie" pairs should be equal (expected = earlier stage); "ratio" pairs should keep a stable share (expected = earlier stage × the median ratio of the other ${u}s; the first ${u} is warm-up). gap = later stage − expected. Status: off = gap beyond the pair's band (at least ${st.variancePct}% of the earlier stage, wider for noisy ratio pairs) AND over ${money(st.varianceAmount)}; watch = beyond half the band AND over that amount; n/a = warm-up.`,
  ].join("\n");
  const tables = (window: number) => an.pairs.map((p) => {
    const keep = p.tie.slice(-window);
    return [`${p.label} (${p.mode}) by ${u}${keep.length < p.tie.length ? ` (last ${keep.length} of ${p.tie.length})` : ""}:`,
      `${u} | ${p.a} | ${p.b} | ratio | expected | gap | status`,
      ...keep.map((t) => `${periodLabel(t.period, u)} | ${money(t.a)} | ${money(t.b)} | ${pct(t.ratio)} | ${t.expected === null ? "n/a" : money(t.expected)} | ${t.gap === null ? "n/a" : money(t.gap)} | ${t.status}`)].join("\n");
  }).join("\n\n");
  const findingText = (list: Finding[], nRows: number) => list.length ? ["Findings, largest money impact first:", ...list.map((f, i) => [`${i + 1}. ${f.title}`, ...f.lines.map((l) => `   - ${l}`), ...f.rows.slice(0, nRows).map(refLine)].join("\n"))].join("\n") : "Findings: none over the thresholds.";
  const total = Math.max(0, ...an.pairs.map((p) => p.tie.length));
  const build = (window: number, list: Finding[], nRows: number) => {
    const omitted = findings.length - list.length;
    return [head, an.pairs.length ? tables(window) : "", findingText(list, nRows), omitted > 0 ? `(${omitted} smaller finding(s) left out to fit)` : ""].filter(Boolean).join("\n\n");
  };
  // Priority when narrowing: keep findings (largest first) over old periods; within that, recent periods (down to 6)
  // before example rows; only below that, fewer findings; a 3-period view is the last resort.
  const windows = [...new Set([total, 36, 24, 12, 6, 3].map((w) => Math.min(w, total)))];
  const rowsSteps = [...new Set([rowsPerFinding, Math.min(rowsPerFinding, 1), 0])];
  for (let n = findings.length; n >= 0; n--) {
    for (const window of windows) {
      for (const nRows of rowsSteps) {
        const text = build(window, findings.slice(0, n), nRows);
        if (text.length <= budget) return { text, chars: text.length, budget, periodsShown: Math.min(window, total), periodsTotal: total, findingsShown: n, findingsTotal: findings.length, rowsPerFinding: nRows };
      }
    }
  }
  const minimal = [head, findingText([], 0)].join("\n\n");
  if (minimal.length <= budget) return { text: minimal, chars: minimal.length, budget, periodsShown: 0, periodsTotal: total, findingsShown: 0, findingsTotal: findings.length, rowsPerFinding: 0 };
  throw new Error(`even the file list and flow (${minimal.length} characters) exceed the evidence budget of ${budget}`);
}

/** Numbers in an answer that do not appear in the evidence. A heuristic: a figure the model derived (its own sum) is listed too, as "not found", not as wrong. */
export function verifyAnswer(answer: string, evidence: string): { checked: number; notFound: string[] } {
  const norm = (s: string) => { const neg = /^\(.*\)$/.test(s) || s.startsWith("-"); const v = Number(s.replace(/[^0-9.]/g, "")); return Number.isFinite(v) ? Math.round((neg ? -v : v) * 100) : NaN; };
  const NUM = /\(?-?\$?\d{1,3}(?:,\d{3})+(?:\.\d+)?\)?|\(?-?\$?\d+\.\d+\)?|\b\d{3,}\b/g;
  const known = new Set<number>();
  for (const m of evidence.match(NUM) ?? []) { const v = norm(m); if (!Number.isNaN(v)) { known.add(v); known.add(-v); } }
  const seen = new Set<string>(), notFound: string[] = [];
  let checked = 0;
  for (const m of answer.match(NUM) ?? []) {
    if (/^(19|20)\d\d$/.test(m)) continue; // years
    const v = norm(m);
    if (Number.isNaN(v) || seen.has(m)) continue;
    seen.add(m); checked++;
    if (!known.has(v)) notFound.push(m);
  }
  return { checked, notFound };
}
