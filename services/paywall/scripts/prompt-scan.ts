/**
 * F2: masks the prompt a user types to the buyer agent, on this computer,
 * before the agent's model (Bedrock) sees it. Two detectors, chosen with
 * --prompt-scanner (default both):
 *
 *   client    scripts/client-mask.ts: patterns only; a name only after a label
 *   presidio  a Presidio analyzer the tenant runs on this computer (default
 *             http://127.0.0.1:5002, the "presidio" container), asked for
 *             ChainAim's entity set and ad-hoc recognizers (the gateway's
 *             privacy/entities.ts), so it also catches a bare name
 *
 * Their spans are merged (the longer wins, then the earlier) and masked as
 * <C_TYPE_n>: the C_ keeps them apart from the gateway's own <TYPE_n>. Cards
 * become [CARD REMOVED]; health terms stay in the text, as on the gateway.
 * The masked text is then checked again: every detector in use runs on it
 * (a span inside a placeholder does not count), then the gateway's residual
 * check (long digit runs, phone numbers, e-mails, titled names).
 *
 * Fail closed: when Presidio is in use and it does not answer, answers an
 * error, or returns a malformed result, the prompt is refused (AskRefused)
 * and nothing is sent. There is no silent fallback to the client detector.
 * Refusal messages name the scanner and the failure, never the prompt's text.
 */
import { detection, isCard, isMasked, parseExtraGroups } from "../../gateway/src/privacy/entities.ts";
import { PresidioClient, PresidioError, waitForPresidio } from "../../gateway/src/privacy/presidio.ts";
import { DEFAULT_RESIDUAL, residualHits } from "../../gateway/src/privacy/residual.ts";
import { detect as clientDetect, mask, type Found, type Masked } from "./client-mask.ts";
import { AskRefused } from "./private-ask-core.ts";

export const PROMPT_SCANNERS = ["client", "presidio", "both"] as const;
export type PromptScanner = (typeof PROMPT_SCANNERS)[number];

export type PromptScanOptions = {
  /** Which detectors run. */
  scanner: PromptScanner;
  /** client-mask: mask names found after a label. */
  names: boolean;
  /** Required when scanner is presidio or both. */
  presidio?: PresidioClient;
  /** Run the gateway's residual check on the masked prompt. */
  residual: boolean;
};

/** How to reach the tenant's own Presidio. */
export type PresidioSettings = {
  url: string;
  /** Minimum entity score; the gateway uses 0.4. */
  threshold: number;
  timeoutMs: number;
  /** The gateway's --extra-entities syntax: default, all, none, or group names. */
  extraEntities: string;
};

export function presidioClient(s: PresidioSettings): PresidioClient {
  return new PresidioClient({ url: s.url, threshold: s.threshold, timeoutMs: s.timeoutMs, detection: detection(parseExtraGroups(s.extraEntities)) });
}

/** <TYPE_n>, <C_TYPE_n> and [CARD REMOVED]: what masking leaves behind. */
const PLACEHOLDER = /<\s*[A-Za-z][A-Za-z_]*?_\d+\s*>|\[CARD REMOVED\]/g;

const REFUSE = "refusing to send the prompt";

export class PromptScan {
  readonly options: PromptScanOptions;

  constructor(options: PromptScanOptions) {
    if (!(PROMPT_SCANNERS as readonly string[]).includes(options.scanner)) throw new Error(`unknown prompt scanner ${options.scanner}; use ${PROMPT_SCANNERS.join(", ")}`);
    if (options.scanner !== "client" && !options.presidio) throw new Error(`prompt scanner ${options.scanner} needs a Presidio client`);
    this.options = options;
  }

  get usesClient(): boolean {
    return this.options.scanner !== "presidio";
  }

  get usesPresidio(): boolean {
    return this.options.scanner !== "client";
  }

  /** For the start-up line: which detectors run. */
  describe(): string {
    const parts = [...(this.usesClient ? ["client patterns"] : []), ...(this.usesPresidio ? [`Presidio at ${this.options.presidio!.url}`] : [])];
    return parts.join(" + ");
  }

  /**
   * Start-up check: Presidio answers, supports the entities ChainAim needs,
   * and finds every value in the gateway's test sentence. Retries until
   * waitMs runs out (0: one try). Throws with entity types only. A no-op
   * for the client detector alone.
   */
  async ready(waitMs: number): Promise<void> {
    if (!this.usesPresidio) return;
    await waitForPresidio(this.options.presidio!, waitMs);
  }

  /** Every span to mask in `text`, from every detector in use; non-overlapping, sorted by start. */
  async detect(text: string): Promise<Found[]> {
    const spans: Found[] = this.usesClient ? clientDetect(text, { names: this.options.names }) : [];
    if (this.usesPresidio) spans.push(...(await this.analyze(text)));
    return resolveOverlaps(spans);
  }

  /** detect(), mask, then the self-check and the residual check. AskRefused (exit code 1) when anything fails. */
  async mask(text: string): Promise<Masked> {
    const result = mask(text, await this.detect(text));
    const placeholders = placeholderSpans(result.masked);
    const left = (await this.detect(result.masked)).filter((f) => !placeholders.some(([s, e]) => f.start < e && s < f.end));
    if (left.length > 0) throw new AskRefused(`${REFUSE}: after masking it still holds a value that should be masked; nothing was sent`, 1);
    if (this.options.residual) {
      const hits = residualHits([result.masked], DEFAULT_RESIDUAL);
      if (hits.length > 0) {
        const kinds = hits.map((h) => `${h.kind} ${h.count}`).join(", ");
        throw new AskRefused(`${REFUSE}: after masking it still looks like it holds personal data (${kinds}); nothing was sent. Take it out of the prompt, or turn this check off with --prompt-residual off`, 1);
      }
    }
    return result;
  }

  /** Presidio's spans of types that are masked or removed; health terms are dropped (they stay in the text). */
  private async analyze(text: string): Promise<Found[]> {
    const presidio = this.options.presidio!;
    let found;
    try {
      found = await presidio.analyze(text);
    } catch (e) {
      const why = e instanceof PresidioError ? e.message : e instanceof Error ? e.name : "unknown error";
      throw new AskRefused(`${REFUSE}: the Presidio scanner at ${presidio.url} failed (${why}); nothing was sent`, 1);
    }
    return found.filter((d) => isMasked(d.type) || isCard(d.type)).map((d) => ({ type: d.type, start: d.start, end: d.end }));
  }
}

function placeholderSpans(text: string): [number, number][] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
}

/** Overlapping spans: the longer wins, then the earlier. The result is sorted by start. */
function resolveOverlaps(spans: readonly Found[]): Found[] {
  const ranked = [...spans].sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept: Found[] = [];
  for (const s of ranked) if (!kept.some((k) => s.start < k.end && k.start < s.end)) kept.push(s);
  return kept.sort((a, b) => a.start - b.start);
}
