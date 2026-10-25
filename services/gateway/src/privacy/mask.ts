/**
 * Masking: replace detected values with numbered placeholders the caller can
 * restore, and remove card numbers for good (spec section 5, "Placeholders").
 */
import { isCard, isMasked, type Detected } from "./entities.ts";

export const CARD_REMOVED = "[CARD REMOVED]";

/**
 * One Masker per request. Numbering and the map are shared by every text it
 * masks, so call mask() in reading order (messages in order, left to right).
 * The same value (after trimming; emails ignoring case) always gets the same
 * placeholder, and the map records the first spelling seen. The map lives
 * only as long as this object.
 */
export class Masker {
  /** placeholder -> original value */
  readonly map: Record<string, string> = {};
  cardsRemoved = 0;
  private readonly byValue = new Map<string, string>();
  private readonly lastNumber = new Map<string, number>();

  /** @param entities non-overlapping and sorted by start, as PresidioClient.analyze returns them */
  mask(text: string, entities: readonly Detected[]): string {
    let out = "";
    let at = 0;
    for (const e of entities) {
      const value = text.slice(e.start, e.end);
      out += text.slice(at, e.start);
      if (isCard(e.type)) {
        out += CARD_REMOVED;
        this.cardsRemoved++;
      } else if (isMasked(e.type)) {
        out += this.placeholder(e.type, value);
      } else {
        out += value; // health terms stay: the model needs them
      }
      at = e.end;
    }
    return out + text.slice(at);
  }

  private placeholder(type: string, value: string): string {
    const trimmed = value.trim();
    const key = `${type}\u0000${type === "EMAIL_ADDRESS" ? trimmed.toLowerCase() : trimmed}`;
    let p = this.byValue.get(key);
    if (p === undefined) {
      const n = (this.lastNumber.get(type) ?? 0) + 1;
      this.lastNumber.set(type, n);
      p = `<${type}_${n}>`;
      this.byValue.set(key, p);
      this.map[p] = value;
    }
    return p;
  }
}

/** A chat message as the gateway forwards it: these fields only, and text content only. */
export type TextPart = { type: "text"; text: string };
export type ToolCall = { id?: string; type: "function"; function: { name: string; arguments: string } };
export type Message = { role: string; content?: string | TextPart[] | null; tool_calls?: ToolCall[]; tool_call_id?: string };

/** Receives each text and a context prefix that Presidio reads with it (a JSON key); returns the replacement text. */
export type TextMapper = (text: string, context: string) => string;

/**
 * Rebuild a conversation with every text field passed through fn, in reading
 * order: messages in order; in each, the content (a string or text parts),
 * then each tool call's arguments. Arguments that are JSON are split into
 * their keys and their string and number values, so a masked value can never
 * break JSON escaping; a masked number comes back as a string. Each key is a
 * text of its own, visited before its value, because a model can put an
 * identifier in a key; the value is read with the original key as context.
 * Two keys that mask to the same placeholder become one key (that object
 * loses a value; nothing leaks). An integer that JSON.parse would round is
 * read from its source digits, and goes on unchanged unless it is masked.
 * Fields other than role, content,
 * tool_calls and tool_call_id are dropped, so no unscanned text can ride along.
 */
export function mapConversation(messages: readonly Message[], fn: TextMapper): Message[] {
  return messages.map((m) => {
    const out: Message = { role: m.role };
    if (typeof m.content === "string") out.content = fn(m.content, "");
    else if (Array.isArray(m.content)) out.content = m.content.map((p): TextPart => ({ type: "text", text: fn(p.text, "") }));
    else if (m.content === null) out.content = null;
    if (m.tool_calls) {
      out.tool_calls = m.tool_calls.map((c): ToolCall => ({
        ...(c.id === undefined ? {} : { id: c.id }),
        type: "function",
        function: { name: c.function.name, arguments: mapArguments(c.function.arguments, fn) },
      }));
    }
    if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id;
    return out;
  });
}

function mapArguments(args: string, fn: TextMapper): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args, keepUnsafeInteger);
  } catch {
    return fn(args, "");
  }
  return JSON.stringify(mapJson(parsed, "", fn));
}

/** An integer beyond 2^53 with the digits as sent: JSON.parse would round it, and a card number must reach detection intact. */
class UnsafeInteger {
  readonly source: string;
  constructor(source: string) {
    this.source = source;
  }
}

function keepUnsafeInteger(_key: string, value: unknown, context: { source?: string }): unknown {
  if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value) && context.source !== undefined) {
    return new UnsafeInteger(context.source);
  }
  return value;
}

function mapJson(value: unknown, key: string, fn: TextMapper): unknown {
  const context = key ? `${key}: ` : "";
  if (typeof value === "string") return fn(value, context);
  if (value instanceof UnsafeInteger) {
    const mapped = fn(value.source, context);
    return mapped === value.source ? JSON.rawJSON(value.source) : mapped; // unchanged: the digits as sent; masked: a string
  }
  if (typeof value === "number") {
    const text = String(value);
    const mapped = fn(text, context);
    return mapped === text ? value : mapped;
  }
  if (Array.isArray(value)) return value.map((v) => mapJson(v, key, fn));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => {
        const outKey = fn(k, ""); // the key first: reading order
        return [outKey, mapJson(v, k, fn)];
      }),
    );
  }
  return value;
}

/**
 * Entities found in `context + text`, moved to offsets within `text`. A span
 * that lies entirely in the context is dropped; one that crosses into the
 * value is cut to the value.
 */
export function withinValue(text: string, found: readonly Detected[], contextLength: number): Detected[] {
  const out: Detected[] = [];
  for (const d of found) {
    let start = Math.max(d.start - contextLength, 0);
    const end = Math.min(d.end - contextLength, text.length);
    while (start < end && /\s/.test(text[start])) start++;
    if (end > start) out.push({ ...d, start, end });
  }
  return out;
}

/**
 * Request fields that reach the model besides the messages. They are walked
 * like tool-call arguments: every object key and every string or number
 * value, in reading order, so nothing in them reaches a model unscanned.
 */
export const SCANNED_REQUEST_FIELDS = ["tools", "response_format", "stop"] as const;
export type ScannedField = (typeof SCANNED_REQUEST_FIELDS)[number];
export type ScannedFields = Partial<Record<ScannedField, unknown>>;

/**
 * Context passed for a name a provider must receive exactly as written: a
 * tool's function name, or a json_schema response format's name. A caller
 * refuses the request if masking would change one (a placeholder breaks the
 * provider's name rules, and the model calls tools by name).
 */
export const EXACT_NAME = "\u0000exact-name";

/** Rebuild the scanned request fields with every text passed through fn (see mapConversation). Fields that are absent stay absent. */
export function mapRequestFields(request: Readonly<Record<string, unknown>>, fn: TextMapper): ScannedFields {
  const out: ScannedFields = {};
  for (const field of SCANNED_REQUEST_FIELDS) {
    const value = request[field];
    if (value === undefined) continue;
    if (field === "tools" && Array.isArray(value)) out.tools = value.map((t) => mapTool(t, fn));
    else if (field === "response_format" && isRecord(value)) out.response_format = mapResponseFormat(value, fn);
    else out[field] = mapJson(value, "", fn);
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Entries in their original order, with one key's value produced by `exact` instead of the walk. */
function mapObject(o: Record<string, unknown>, fn: TextMapper, exactKey: string, exact: (v: unknown) => unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(o).map(([k, v]) => (k === exactKey ? [k, exact(v)] : [fn(k, ""), mapJson(v, k, fn)])),
  );
}

/** { type: "function", function: { name, description, parameters } }: the name is exact, everything else is walked. */
function mapTool(tool: unknown, fn: TextMapper): unknown {
  if (!isRecord(tool) || !isRecord(tool.function)) return mapJson(tool, "", fn);
  const f = tool.function;
  return mapObject(tool, fn, "function", () => mapObject(f, fn, "name", (n) => (typeof n === "string" ? fn(n, EXACT_NAME) : mapJson(n, "name", fn))));
}

/** { type: "json_schema", json_schema: { name, schema, ... } }: the schema's name is exact, everything else is walked. */
function mapResponseFormat(format: Record<string, unknown>, fn: TextMapper): unknown {
  const js = format.json_schema;
  if (!isRecord(js)) return mapJson(format, "", fn);
  return mapObject(format, fn, "json_schema", () => mapObject(js, fn, "name", (n) => (typeof n === "string" ? fn(n, EXACT_NAME) : mapJson(n, "name", fn))));
}

/** Every string a rebuilt conversation or request field holds (keys included), for the residual check. */
export function collectTexts(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectTexts(v, out);
  else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      collectTexts(v, out);
    }
  }
  return out;
}
