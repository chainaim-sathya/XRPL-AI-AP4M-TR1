/**
 * Restore: put the original values back in place of <TYPE_N> placeholders
 * (spec section 5, "Restore"). A placeholder with no map entry stays as it is
 * and is counted, so the ledger shows how often a model invents one.
 */

/**
 * Lenient restore (on by default, --restore-lenient): models, small local ones especially, often
 * copy a placeholder without its angle brackets ("Person_1"), inside parentheses, square or curly
 * brackets, or in another case. Those forms are restored too, but only for names this request's
 * map holds, and only as a whole token (PERSON_1 never matches inside PERSON_10 or C_PERSON_1).
 * Parentheses and quotes are left in place as the model's prose; <>, [] and {} around a known
 * name are dropped like the angle brackets. A bare token that looks like a placeholder of a type
 * in the map (PERSON_9) but is not in it is counted as unresolved, so a missed restore shows.
 */
export type RestoreStats = { unresolved: number; lenient?: number };
export type RestoreOptions = { lenient?: boolean };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BEFORE = "(?<![A-Za-z0-9_])";
const AFTER = "(?![A-Za-z0-9_])";
/** <TYPE_N>, in any case, with spaces allowed inside the brackets. */
const BRACKETED = "<\\s*(?<b>[A-Za-z][A-Za-z_]*?_\\d+)\\s*>";

function compile(map: Readonly<Record<string, string>>, lenient: boolean): RegExp {
  const names = Object.keys(map).map((k) => k.replace(/^<\s*|\s*>$/g, "").toUpperCase());
  const parts = [BRACKETED];
  if (lenient && names.length > 0) {
    const n = names.sort((a, b) => b.length - a.length).map(esc).join("|");
    const types = [...new Set(names.map((x) => x.replace(/_\d+$/, "")))].map(esc).join("|");
    parts.push(`\\[\\s*(?<s>${n})\\s*\\]`, `\\{\\s*(?<c>${n})\\s*\\}`, `${BEFORE}(?<w>${n})${AFTER}`, `${BEFORE}(?<l>(?:${types})_\\d+)${AFTER}`);
  }
  return new RegExp(parts.join("|"), "gi");
}

/** @param json the text is inside a JSON string (tool-call arguments), so values are JSON-escaped */
export function restoreText(text: string, map: Readonly<Record<string, string>>, stats: RestoreStats, json = false, options: RestoreOptions = {}): string {
  const re = compile(map, options.lenient !== false);
  const enc = (v: string) => (json ? JSON.stringify(v).slice(1, -1) : v);
  return text.replace(re, (whole: string, ...rest: unknown[]) => {
    const g = rest[rest.length - 1] as Record<string, string | undefined>;
    if (g.b !== undefined) {
      // <C_...> is the client's own placeholder (client-side masking): the client restores it, so it is neither ours nor unresolved.
      if (/^C_/i.test(g.b)) return whole;
      const value = map[`<${g.b.toUpperCase()}>`];
      if (value === undefined) {
        stats.unresolved++;
        return whole;
      }
      return enc(value);
    }
    const core = g.s ?? g.c ?? g.w;
    if (core !== undefined) {
      const value = map[`<${core.toUpperCase()}>`];
      if (value === undefined) {
        stats.unresolved++;
        return whole;
      }
      stats.lenient = (stats.lenient ?? 0) + 1;
      return enc(value);
    }
    if (g.l !== undefined) stats.unresolved++;
    return whole;
  });
}

/** True when the text holds a placeholder (server <TYPE_N>, client <C_TYPE_N>) or a removed card. */
export function hasPlaceholder(text: string): boolean {
  return /<\s*[A-Za-z][A-Za-z_]*?_\d+\s*>|\[CARD REMOVED\]/.test(text);
}

/** Sent to the model as the first system message when the masked request holds placeholders (--placeholder-instruction). */
export const PLACEHOLDER_INSTRUCTION =
  "Some values in this conversation were replaced by placeholders such as <PERSON_1> or <C_EMAIL_ADDRESS_1>. " +
  "When you refer to one of them, copy the placeholder exactly as written, including the angle brackets, its case and its number. " +
  "Do not rename, translate, explain or remove the brackets of a placeholder, and do not invent new ones.";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Restore a chat completion in place: content, reasoning, refusal and tool-call arguments of every choice. */
export function restoreCompletion(completion: unknown, map: Readonly<Record<string, string>>, stats: RestoreStats, options: RestoreOptions = {}): void {
  const choices = isObj(completion) ? completion.choices : undefined;
  if (!Array.isArray(choices)) return;
  for (const choice of choices) {
    const message = isObj(choice) ? choice.message : undefined;
    if (!isObj(message)) continue;
    for (const field of ["content", "reasoning", "refusal"]) {
      const v = message[field];
      if (typeof v === "string") message[field] = restoreText(v, map, stats, false, options);
    }
    if (!Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      const fn = isObj(call) ? call.function : undefined;
      if (isObj(fn) && typeof fn.arguments === "string") fn.arguments = restoreText(fn.arguments, map, stats, true, options);
    }
  }
}
