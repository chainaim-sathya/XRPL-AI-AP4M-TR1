/**
 * P14: where an agent run's time goes. A Timing collects named phases (in
 * milliseconds) as they finish; the agent prints them per request with
 * --timing on (a table) or --timing json (one line, for collecting runs and
 * working out p95). Phases hold names and durations only, never text.
 *
 * Phase names used by the agent (scripts/agent.ts, agent-core.ts, xrpl.ts):
 *   startup              process start to the first line of agent.ts (Node, TypeScript, module loading)
 *   presidio_check       the prompt scanner's start-up check
 *   prompt_mask          masking the typed prompt (client patterns + Presidio)
 *   agent_invoke         the whole agent run: every Bedrock turn plus every tool call
 *   tool.total           each tool call, end to end
 *   tool.doc_read        reading the document's text (scripts/extract.ts: PDF, Word, Excel, CSV, plain text)
 *   tool.doc_mask        masking the document's text on this machine
 *   tool.ledger_connect  opening the XRP Ledger WebSocket
 *   tool.quote_402       the first, unpaid call: the paywall's 402 and price
 *   tool.ledger_network  server_info: the ledger is on the right network
 *   tool.ledger_prepare  account sequence, fee and ledger index for the Payment
 *   tool.sign            signing and checking the Payment
 *   tool.paid_call       the paid call: paywall verify, gateway (mask, model, restore), settle
 * Derived when reported:
 *   bedrock_and_loop     agent_invoke minus tool.total: Bedrock turns (AWS credentials on the first), the SDK loop
 *   tool.other           tool.total minus its listed parts (ledger disconnect, answer parsing)
 */

export type Phase = { name: string; ms: number };

export class Timing {
  private phases: Phase[] = [];

  add(name: string, ms: number): void {
    this.phases.push({ name, ms });
  }

  /** Time `fn` and record it under `name`, whether it succeeds or throws. */
  async time<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.add(name, performance.now() - start);
    }
  }

  /** The phases recorded since the last take(), and forget them. */
  take(): Phase[] {
    return this.phases.splice(0);
  }
}

/** Phases summed by name, rounded to whole milliseconds, with the derived ones added. */
export function summarize(phases: readonly Phase[]): Record<string, number> {
  const sums: Record<string, number> = {};
  for (const p of phases) sums[p.name] = (sums[p.name] ?? 0) + p.ms;
  if (sums.agent_invoke !== undefined) sums.bedrock_and_loop = sums.agent_invoke - (sums["tool.total"] ?? 0);
  if (sums["tool.total"] !== undefined) {
    const parts = Object.entries(sums)
      .filter(([name]) => name.startsWith("tool.") && name !== "tool.total" && name !== "tool.other")
      .reduce((n, [, ms]) => n + ms, 0);
    sums["tool.other"] = sums["tool.total"] - parts;
  }
  return Object.fromEntries(Object.entries(sums).map(([name, ms]) => [name, Math.round(ms)]));
}

const ORDER = [
  "startup",
  "presidio_check",
  "prompt_mask",
  "agent_invoke",
  "bedrock_and_loop",
  "tool.total",
  "tool.doc_read",
  "tool.doc_mask",
  "tool.ledger_connect",
  "tool.quote_402",
  "tool.ledger_network",
  "tool.ledger_prepare",
  "tool.sign",
  "tool.paid_call",
  "tool.other",
];

/** A table, one phase per line, indented by level; `sinceStart` is the process's age when reported. */
export function formatTiming(summary: Record<string, number>, sinceStart: number): string {
  const names = [...ORDER.filter((n) => n in summary), ...Object.keys(summary).filter((n) => !ORDER.includes(n))];
  const indent = (n: string): string => (n === "bedrock_and_loop" || n === "tool.total" ? "  " : n.startsWith("tool.") ? "    " : "");
  const lines = names.map((n) => `${(indent(n) + n).padEnd(24)} ${String(summary[n]).padStart(7)} ms`);
  lines.push(`${"since process start".padEnd(24)} ${String(Math.round(sinceStart)).padStart(7)} ms`);
  return lines.join("\n");
}
