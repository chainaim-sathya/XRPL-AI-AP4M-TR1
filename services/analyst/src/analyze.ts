/**
 * The analysis: every row of every included file is read; the results are exact.
 *
 * value: each row's amount after the file's measure (inflows: positive amounts; outflows: negative amounts, as positive
 *        numbers; abs: absolute amounts; net: signed amounts). Rows the measure excludes have no value.
 * pairs: each adjacent pair in the recipe's flow (A then B), plus first-to-last when the flow has 3 or more files.
 * Two ways a pair is judged, per period:
 *   tie   — B should equal A (collections vs deposits): expected = A, gap = B − A.
 *   ratio — B should be a STABLE share of A (production vs collections: payments are a fraction of charges):
 *           the first period is warm-up; expected = A × the median B/A of the other periods (or settings.expectedRatio);
 *           gap = B − expected. A falling collection rate shows up here; a normal shortfall does not.
 *   auto  — tie when the median |B/A − 1| across periods is at most 10%, otherwise ratio.
 * A period is "off" when |deviation| is over the band (variancePct, or wider for noisy ratio pairs) AND |gap| is over
 * varianceAmount; "watch" when over half the band AND the amount; "n/a" for the warm-up period in ratio mode.
 */
import { type Settings } from "./config.ts";
import { type Db, amountExpr, dateExpr, ident, loadText, lockFiles, rows } from "./db.ts";
import { type FileProfile, type Measure, type Recipe } from "./profile.ts";

export type PeriodRow = { period: string; rows: number; total: number };
export type Status = "ok" | "watch" | "off" | "n/a";
export type TieRow = { period: string; a: number; b: number; variance: number; ratio: number | null; expected: number | null; gap: number | null; deviation: number | null; status: Status };
export type Run = { start: string; end: string; periods: number; cumulativeGap: number; perPeriodChange: number; ongoing: boolean; baseline: number | null; baselinePeriods: number; latestRatio: number | null };
export type Ref = { file: string; row: number; date: string; value: number; party: string | null; reference: string | null };
export type Unmatched = { count: number; amount: number; aged: number; agedAmount: number; byPeriod: Record<string, number>; byParty: { party: string; count: number; amount: number; share: number; normalShare: number }[]; partyUseful: boolean; top: Ref[] };
export type MatchResult = { by: "reference" | "amount"; mode: string; informative: boolean; matchedA: number; matchedB: number; rateA: number; rateB: number; unmatchedA: Unmatched; unmatchedB: Unmatched };
export type Pair = { a: string; b: string; label: string; mode: "tie" | "ratio"; tie: TieRow[]; run: Run | null; match: MatchResult | null };
export type FileResult = { name: string; kind: string; measure: Measure; rows: number; valued: number; skipped: number; from: string | null; to: string | null; totals: PeriodRow[]; duplicates: { groups: number; extraRows: number; extraAmount: number; top: Ref[] }; outliers: Ref[]; gaps: string[] };
export type Analysis = { periodUnit: Settings["period"]; files: FileResult[]; pairs: Pair[]; settings: Settings };

const MEASURE_SQL: Record<Measure, (amt: string) => string> = {
  net: (a) => a,
  inflows: (a) => `CASE WHEN ${a} > 0 THEN ${a} END`,
  outflows: (a) => `CASE WHEN ${a} < 0 THEN -(${a}) END`,
  abs: (a) => `abs(${a})`,
};
const r2 = (n: number): number => Math.round(n * 100) / 100;
const r4 = (n: number): number => Math.round(n * 10000) / 10000;
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const optText = (col: string | undefined): string => (col ? `NULLIF(trim(${ident(col)}), '')` : "NULL");
const DAY = 86400000;
const tms = (iso: string): number => Date.parse(iso + "T00:00:00Z");

export async function analyze(db: Db, recipe: Recipe, profiles: FileProfile[], s: Settings, limits: { topRows: number }): Promise<Analysis> {
  const included = Object.entries(recipe.files).filter(([, f]) => f.include);
  const byName = new Map(profiles.map((p) => [p.name, p]));
  // 1. Load as text, normalize, then lock file access before any analysis runs.
  for (const [i, [name, f]] of included.entries()) {
    await loadText(db, `raw${i}`, byName.get(name)!.path);
    const amt = f.roles.amount ? amountExpr(f.roles.amount) : `coalesce(${amountExpr(f.roles.credit!)}, 0) - coalesce(${amountExpr(f.roles.debit!)}, 0)`;
    await db.conn.run(`CREATE TABLE ${ident("n_" + name)} AS
      SELECT __row AS rid, ${dateExpr(f.roles.date!, f.dateFormat)} AS d, amt AS amount, ${MEASURE_SQL[f.measure]("amt")} AS value,
             ${optText(f.roles.party)} AS party, ${optText(f.roles.reference)} AS reference, ${optText(f.roles.category)} AS category
      FROM (SELECT *, ${amt} AS amt FROM ${ident(`raw${i}`)})`);
    await db.conn.run(`DROP TABLE ${ident(`raw${i}`)}`);
  }
  await lockFiles(db);
  const unit = s.period;
  const per = (d: string) => `strftime(date_trunc('${unit}', ${d}), '%Y-%m-%d')`;

  // 2. Per file: totals by period, duplicates, outliers, gaps.
  const files: FileResult[] = [];
  for (const [name, f] of included) {
    const t = ident("n_" + name);
    const [c] = await rows<{ n: number; valued: number; skipped: number; f: string | null; t: string | null }>(db, `SELECT CAST(count(*) AS INTEGER) n,
      CAST(count(*) FILTER (WHERE d IS NOT NULL AND value IS NOT NULL) AS INTEGER) valued,
      CAST(count(*) FILTER (WHERE d IS NULL OR amount IS NULL) AS INTEGER) skipped,
      CAST(min(d) AS VARCHAR) f, CAST(max(d) AS VARCHAR) t FROM ${t}`);
    const totals = await rows<PeriodRow>(db, `SELECT ${per("d")} period, CAST(count(*) AS INTEGER) "rows", round(sum(value), 2) total
      FROM ${t} WHERE d IS NOT NULL AND value IS NOT NULL GROUP BY 1 ORDER BY 1`);
    const dupGroups = await rows<{ n: number; d: string; value: number; party: string | null; reference: string | null; first: number }>(db, `SELECT CAST(count(*) AS INTEGER) n, CAST(d AS VARCHAR) d, value, party, reference, CAST(min(rid) AS INTEGER) "first"
      FROM ${t} WHERE d IS NOT NULL AND value IS NOT NULL AND (reference IS NOT NULL OR party IS NOT NULL)
      GROUP BY d, value, party, reference HAVING count(*) > 1 ORDER BY value * (count(*) - 1) DESC`);
    const duplicates = {
      groups: dupGroups.length,
      extraRows: dupGroups.reduce((n, g) => n + g.n - 1, 0),
      extraAmount: r2(dupGroups.reduce((n, g) => n + g.value * (g.n - 1), 0)),
      top: dupGroups.slice(0, limits.topRows).map((g) => ({ file: name, row: g.first, date: g.d, value: g.value, party: g.party, reference: g.reference })),
    };
    // Outliers: more than 6 median absolute deviations from the median AND more than 10× the median — rare, large amounts, not just the pricier rows.
    const outliers = await rows<Ref>(db, `WITH v AS (SELECT rid, CAST(d AS VARCHAR) "date", value, party, reference FROM ${t} WHERE d IS NOT NULL AND value IS NOT NULL),
      s AS (SELECT median(value) m FROM v), mad AS (SELECT median(abs(value - (SELECT m FROM s))) mad FROM v)
      SELECT CAST(rid AS INTEGER) "row", "date", value, party, reference FROM v
      WHERE (SELECT mad FROM mad) > 0 AND abs(value - (SELECT m FROM s)) > 6 * (SELECT mad FROM mad) AND abs(value) > 10 * abs((SELECT m FROM s))
      ORDER BY abs(value) DESC LIMIT ${limits.topRows}`);
    const gaps = c.f && c.t ? (await rows<{ p: string }>(db, `SELECT strftime(p, '%Y-%m-%d') p FROM range(date_trunc('${unit}', DATE '${c.f}'), date_trunc('${unit}', DATE '${c.t}') + INTERVAL 1 ${unit}, INTERVAL 1 ${unit}) r(p)
      WHERE strftime(p, '%Y-%m-%d') NOT IN (SELECT DISTINCT ${per("d")} FROM ${t} WHERE d IS NOT NULL)`)).map((g) => g.p) : [];
    files.push({ name, kind: f.kind, measure: f.measure, rows: c.n, valued: c.valued, skipped: c.skipped, from: c.f, to: c.t, totals, duplicates, outliers: outliers.map((o) => ({ ...o, file: name })), gaps });
  }

  // 3. Pairs along the flow: per-period judgement, since when, row matching.
  const flow = recipe.flow;
  const pairsSpec: [string, string][] = flow.slice(1).map((b, i) => [flow[i], b]);
  if (flow.length >= 3) pairsSpec.push([flow[0], flow[flow.length - 1]]);
  const pairs: Pair[] = [];
  // Each file's rows are read into memory once per analysis, however many pairs it belongs to.
  const cache = new Map<string, Promise<Row[]>>();
  const loadRows = (f: string): Promise<Row[]> => cache.get(f) ?? cache.set(f, rows<Row>(db, `SELECT CAST(rid AS INTEGER) "row", CAST(d AS VARCHAR) "date", value, party, reference FROM ${ident("n_" + f)} WHERE d IS NOT NULL AND value IS NOT NULL ORDER BY d, rid`)).get(f)!;
  for (const [a, b] of pairsSpec) {
    const fa = files.find((f) => f.name === a)!, fb = files.find((f) => f.name === b)!;
    const ma = new Map(fa.totals.map((t) => [t.period, t.total])), mb = new Map(fb.totals.map((t) => [t.period, t.total]));
    // Only periods both files cover, so a file that starts later does not look like a 100% variance.
    const lo = [fa.from, fb.from].filter(Boolean).sort().pop() as string | undefined, hi = [fa.to, fb.to].filter(Boolean).sort()[0] as string | undefined;
    const periods = [...new Set([...ma.keys(), ...mb.keys()])].sort().filter((p) => (!lo || p >= periodStart(lo, unit)) && (!hi || p <= hi));
    const base = periods.map((p) => ({ period: p, a: r2(ma.get(p) ?? 0), b: r2(mb.get(p) ?? 0) }));
    const ratios = base.filter((x) => x.a).map((x) => x.b / x.a);
    const mode: "tie" | "ratio" = s.pairMode !== "auto" ? s.pairMode : ratios.length && median(ratios.map((r) => Math.abs(r - 1))) > 0.1 ? "ratio" : "tie";
    const tie = judge(base, mode, s);
    const match = s.match === "none" ? null : await matchPair(loadRows, a, b, s, limits.topRows, recipe, fb.to);
    pairs.push({ a, b, label: `${a} → ${b}`, mode, tie, run: onset(tie, mode, s), match });
  }
  return { periodUnit: unit, files, pairs, settings: s };
}

/**
 * Per period: expected B, gap, deviation and status.
 * tie:   expected ratio 1; band = variancePct.
 * ratio: the first period is warm-up ("n/a": flows that lag, like payments after charges, start partial). The expected
 *        ratio is the median B/A over the other periods (robust to a few bad months) and the band widens to
 *        3 × the median absolute deviation of those ratios when they are noisier than variancePct. A leak spanning
 *        more than half the periods would move that median; the person can then pin the ratio in the recipe
 *        (settings.expectedRatio, applied to ratio pairs).
 */
export function judge(base: { period: string; a: number; b: number }[], mode: "tie" | "ratio", s: Settings): TieRow[] {
  let expectedRatio = 1, band = s.variancePct / 100;
  const warmup = mode === "ratio" ? 1 : 0;
  if (mode === "ratio") {
    const rs = base.slice(warmup).filter((x) => x.a).map((x) => x.b / x.a);
    if (!rs.length) return base.map((x) => ({ period: x.period, a: x.a, b: x.b, variance: r2(x.b - x.a), ratio: x.a ? r4(x.b / x.a) : null, expected: null, gap: null, deviation: null, status: "n/a" as Status }));
    expectedRatio = typeof s.expectedRatio === "number" && s.expectedRatio > 0 ? s.expectedRatio : median(rs);
    band = Math.max(band, 3 * median(rs.map((r) => Math.abs(r - expectedRatio))));
  }
  return base.map((x, i) => {
    const variance = r2(x.b - x.a), ratio = x.a ? r4(x.b / x.a) : null;
    if (i < warmup || !x.a) return { period: x.period, a: x.a, b: x.b, variance, ratio, expected: null, gap: null, deviation: null, status: (mode === "tie" && !x.a && x.b ? "off" : "n/a") as Status };
    const expected = r2(x.a * expectedRatio), gap = r2(x.b - expected), deviation = r4((x.b - expected) / x.a);
    const overAmt = Math.abs(gap) > s.varianceAmount;
    const status: Status = overAmt && Math.abs(deviation) > band ? "off" : overAmt && Math.abs(deviation) > band / 2 ? "watch" : "ok";
    return { period: x.period, a: x.a, b: x.b, variance, ratio, expected, gap, deviation, status };
  });
}

const periodStart = (iso: string, unit: Settings["period"]): string => {
  const d = new Date(iso + "T00:00:00Z");
  if (unit === "month") return iso.slice(0, 7) + "-01";
  if (unit === "quarter") return `${iso.slice(0, 4)}-${String(Math.floor(d.getUTCMonth() / 3) * 3 + 1).padStart(2, "0")}-01`;
  const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day); return d.toISOString().slice(0, 10);
};

/** Since when: the latest run of consecutive "off" periods (ongoing when it reaches the last period), with the baseline just before it (tie mode: average deviation; ratio mode: the expected ratio at the run's start). */
export function onset(tie: TieRow[], mode: "tie" | "ratio", s: Settings): Run | null {
  let end = -1;
  for (let i = tie.length - 1; i >= 0; i--) if (tie[i].status === "off") { end = i; break; }
  if (end === -1) return null;
  let start = end;
  while (start > 0 && tie[start - 1].status === "off") start--;
  const run = tie.slice(start, end + 1);
  const gaps = run.map((t) => t.gap ?? t.variance);
  const cumulativeGap = r2(gaps.reduce((n, g) => n + g, 0));
  // Least-squares slope of the gap across the run: how much it changes per period (more negative = growing shortfall).
  const mx = (run.length - 1) / 2, my = cumulativeGap / run.length;
  const den = run.reduce((n, _, i) => n + (i - mx) ** 2, 0);
  const slope = den ? run.reduce((n, _, i) => n + (i - mx) * (gaps[i] - my), 0) / den : 0;
  const before = tie.slice(Math.max(0, start - s.baselinePeriods), start).filter((t) => t.deviation !== null);
  const baseline = mode === "ratio"
    ? (tie[start].expected !== null && tie[start].a ? r4(tie[start].expected! / tie[start].a) : null)
    : (before.length ? r4(before.reduce((n, t) => n + t.deviation!, 0) / before.length) : null);
  return { start: run[0].period, end: run[run.length - 1].period, periods: run.length, cumulativeGap, perPeriodChange: r2(slope), ongoing: end === tie.length - 1, baseline, baselinePeriods: before.length, latestRatio: tie[tie.length - 1].ratio };
}

type Row = { row: number; date: string; value: number; party: string | null; reference: string | null };

/**
 * Row matching for a pair.
 * - by reference, when both files have a reference column (claim, invoice, check number): a reference in A is matched
 *   when it appears anywhere in B (a claim may be paid in several payments, at any amount). Unmatched A rows older
 *   than agingDays before B's last date are the ones that count (e.g. claims never paid).
 * - by amount otherwise: value within amountTolerance and date within dateWindowDays — one-to-one, then many-to-one
 *   (all still-unmatched A rows of one day summing to one B row, a daily batch deposit).
 * Under 20% (by reference) or 50% (by amount) matched on both sides means the files are not row-for-row comparable;
 * the result is kept but marked not informative (only the period judgement is meaningful then).
 */
async function matchPair(load: (f: string) => Promise<Row[]>, a: string, b: string, s: Settings, topRows: number, recipe: Recipe, lastB: string | null): Promise<MatchResult> {
  const A = await load(a), B = await load(b);
  const usedA = new Uint8Array(A.length), usedB = new Uint8Array(B.length);
  const byRef = Boolean(recipe.files[a].roles.reference && recipe.files[b].roles.reference);
  let mode: string;
  if (byRef) {
    mode = "reference";
    const norm = (r: string | null) => (r ?? "").trim().toUpperCase();
    const refsB = new Map<string, number[]>(), refsA = new Set<string>();
    B.forEach((r, j) => { const k = norm(r.reference); if (k) (refsB.get(k) ?? refsB.set(k, []).get(k)!).push(j); });
    A.forEach((r, i) => { const k = norm(r.reference); if (!k) return; refsA.add(k); if (refsB.has(k)) usedA[i] = 1; });
    B.forEach((r, j) => { if (refsA.has(norm(r.reference))) usedB[j] = 1; });
  } else {
    const tol = Math.round(s.amountTolerance * 100), win = s.dateWindowDays * DAY;
    const cents = (v: number) => Math.round(v * 100);
    const wantOne = s.match !== "many-to-one", wantMany = s.match !== "one-to-one";
    mode = wantOne && wantMany ? "one-to-one, then many-to-one" : wantOne ? "one-to-one" : "many-to-one";
    if (wantOne) {
      // Per amount (in cents), B rows in date order (B is loaded sorted by date); a binary search finds the window start,
      // so even an amount repeated thousands of times (a standard copay) costs only the rows inside the date window.
      const tb = Float64Array.from(B, (r) => tms(r.date));
      const byCents = new Map<number, number[]>();
      B.forEach((r, j) => { const k = cents(r.value); (byCents.get(k) ?? byCents.set(k, []).get(k)!).push(j); });
      A.forEach((r, i) => {
        let best = -1, bestGap = Infinity;
        const ta = tms(r.date);
        for (let k = cents(r.value) - tol; k <= cents(r.value) + tol; k++) {
          const list = byCents.get(k);
          if (!list) continue;
          let lo = 0, hi = list.length;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (tb[list[mid]] < ta - win) lo = mid + 1; else hi = mid; }
          for (let q = lo; q < list.length && tb[list[q]] <= ta + win; q++) {
            const j = list[q];
            if (usedB[j]) continue;
            const gap = Math.abs(tb[j] - ta);
            if (gap < bestGap) { best = j; bestGap = gap; }
          }
        }
        if (best >= 0) { usedA[i] = 1; usedB[best] = 1; }
      });
    }
    if (wantMany) {
      // One running total per day of the still-unmatched A rows, so each B row is checked against a day in O(1).
      const days = new Map<string, { idx: number[]; sum: number }>();
      A.forEach((r, i) => { if (usedA[i]) return; const d = days.get(r.date) ?? days.set(r.date, { idx: [], sum: 0 }).get(r.date)!; d.idx.push(i); d.sum += cents(r.value); });
      B.forEach((r, j) => {
        if (usedB[j]) return;
        const base = tms(r.date);
        for (let step = 0; step <= s.dateWindowDays * 2; step++) {
          const off = step % 2 ? -Math.ceil(step / 2) : step / 2; // 0, -1, +1, -2, +2 … nearest day first
          const d = days.get(new Date(base + off * DAY).toISOString().slice(0, 10));
          if (!d || d.idx.length < 2 || Math.abs(d.sum - cents(r.value)) > tol) continue;
          for (const i of d.idx) usedA[i] = 1;
          usedB[j] = 1;
          d.idx = []; d.sum = 0; // that day's batch is used up
          break;
        }
      });
    }
  }
  const cutoff = lastB ? tms(lastB) - s.agingDays * DAY : Infinity;
  const summarize = (X: Row[], used: Uint8Array, file: string): Unmatched => {
    const left = X.filter((_, i) => !used[i]);
    const aged = left.filter((r) => tms(r.date) <= cutoff);
    const byPeriod: Record<string, number> = {};
    for (const r of aged.length ? aged : left) { const p = periodStart(r.date, s.period); byPeriod[p] = r2((byPeriod[p] ?? 0) + r.value); }
    const order = (x: Row, y: Row) => Number(tms(y.date) <= cutoff) - Number(tms(x.date) <= cutoff) || Math.abs(y.value) - Math.abs(x.value);
    // Who is behind it: the aged unmatched amount by party, compared with that party's share of all rows in the file.
    const focus = aged.length ? aged : left, focusTotal = focus.reduce((n, r) => n + Math.abs(r.value), 0) || 1;
    const parties = new Map<string, { count: number; amount: number }>();
    for (const r of focus) { const k = r.party ?? "(blank)"; const e = parties.get(k) ?? { count: 0, amount: 0 }; e.count++; e.amount += r.value; parties.set(k, e); }
    const all = new Map<string, number>(); let allTotal = 0;
    for (const r of X) { const k = r.party ?? "(blank)"; all.set(k, (all.get(k) ?? 0) + Math.abs(r.value)); allTotal += Math.abs(r.value); }
    const byParty = [...parties.entries()].map(([party, e]) => ({ party, count: e.count, amount: r2(e.amount), share: r4(Math.abs(e.amount) / focusTotal), normalShare: r4((all.get(party) ?? 0) / (allTotal || 1)) }))
      .sort((p, q) => Math.abs(q.amount) - Math.abs(p.amount)).slice(0, 5);
    // A party breakdown only means something when parties repeat (payers, customers), not when each row has its own text.
    const partyUseful = all.size > 0 && all.size <= Math.max(20, X.length * 0.2);
    return { count: left.length, amount: r2(left.reduce((n, r) => n + r.value, 0)), aged: aged.length, agedAmount: r2(aged.reduce((n, r) => n + r.value, 0)), byPeriod, byParty, partyUseful, top: [...left].sort(order).slice(0, topRows).map((r) => ({ file, ...r })) };
  };
  const matchedA = usedA.reduce((n, v) => n + v, 0), matchedB = usedB.reduce((n, v) => n + v, 0);
  const rateA = A.length ? matchedA / A.length : 0, rateB = B.length ? matchedB / B.length : 0;
  return {
    by: byRef ? "reference" : "amount", mode,
    informative: s.match !== "auto" || Math.max(rateA, rateB) >= (byRef ? 0.2 : 0.5),
    matchedA, matchedB, rateA: r4(rateA), rateB: r4(rateB),
    unmatchedA: summarize(A, usedA, a), unmatchedB: summarize(B, usedB, b),
  };
}
