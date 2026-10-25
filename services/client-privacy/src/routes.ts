/**
 * The four local privacy operations, as HTTP. This file holds no masking logic of
 * its own: it is a thin wrapper over the existing PC-side code so that hack/ap4m
 * can use it without importing services/ (DESIGN/xrplh-18 section 3).
 *
 * Nothing here logs document text, a placeholder map, or any detected value.
 */
import {
  CARD_REMOVED,
  detect,
  mask as maskFound,
  maskText,
  restore,
  type Found,
  type MaskOptions,
  type RestoreOptions,
} from "../../paywall/scripts/client-mask.ts";
import {
  DOC_TYPES,
  DocumentRefused,
  extractDocument,
  parseDocTypes,
  type ExtractOptions,
} from "../../paywall/scripts/extract.ts";

export type Settings = {
  /** Mask labelled names by default; --names off turns it off for every request. */
  names: boolean;
  extract: ExtractOptions;
};

export class BadRequest extends Error {}

function body<T>(value: unknown, shape: (v: Record<string, unknown>) => T): T {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new BadRequest("the body must be a JSON object");
  return shape(value as Record<string, unknown>);
}

function text(v: Record<string, unknown>, key = "text"): string {
  const t = v[key];
  if (typeof t !== "string") throw new BadRequest(`"${key}" must be a string`);
  return t;
}

function maskOptions(v: Record<string, unknown>, settings: Settings): MaskOptions {
  const names = v.names === undefined ? settings.names : v.names;
  if (typeof names !== "boolean") throw new BadRequest('"names" must be true or false');
  return { names };
}

function restoreOptions(v: Record<string, unknown>): RestoreOptions {
  const out: RestoreOptions = {};
  for (const key of ["lenient", "dropPrefix"] as const) {
    if (v[key] !== undefined) {
      if (typeof v[key] !== "boolean") throw new BadRequest(`"${key}" must be true or false`);
      out[key] = v[key] as boolean;
    }
  }
  return out;
}

function placeholderMap(v: Record<string, unknown>): Record<string, string> {
  const map = v.map;
  if (map === null || typeof map !== "object" || Array.isArray(map)) throw new BadRequest('"map" must be a JSON object');
  for (const [k, value] of Object.entries(map)) {
    if (typeof value !== "string") throw new BadRequest(`"map.${k}" must be a string`);
  }
  return map as Record<string, string>;
}

/** POST /mask — mask text on this computer. The map is returned to the caller and kept nowhere here. */
export function postMask(raw: unknown, settings: Settings) {
  return body(raw, (v) => {
    const found = v.found;
    const source = text(v);
    if (found !== undefined) {
      if (!Array.isArray(found)) throw new BadRequest('"found" must be an array when given');
      return maskFound(source, found as readonly Found[]);
    }
    return maskText(source, maskOptions(v, settings));
  });
}

/** POST /scan — report what masking would find, without masking. Values are never returned. */
export function postScan(raw: unknown, settings: Settings) {
  return body(raw, (v) => {
    const found = detect(text(v), maskOptions(v, settings));
    const counts: Record<string, number> = {};
    for (const f of found) counts[f.type] = (counts[f.type] ?? 0) + 1;
    return {
      // Offsets and types only: enough to act on, nothing to re-identify from.
      found: found.map((f) => ({ type: f.type, start: f.start, end: f.end })),
      counts,
      total: found.length,
    };
  });
}

/** POST /restore — put the original values back, on this computer. */
export function postRestore(raw: unknown) {
  return body(raw, (v) => restore(text(v), placeholderMap(v), restoreOptions(v)));
}

/** POST /extract — read a document from this computer's disk into text. */
export async function postExtract(raw: unknown, settings: Settings) {
  const { file, types } = body(raw, (v) => {
    const f = v.file;
    if (typeof f !== "string" || !f) throw new BadRequest('"file" must be a path on this computer');
    let t = settings.extract.types;
    if (v.types !== undefined) {
      if (typeof v.types !== "string") throw new BadRequest('"types" must be a comma-separated string');
      t = parseDocTypes(v.types);
    }
    return { file: f, types: t };
  });
  return extractDocument(file, { ...settings.extract, types });
}

export const INFO = {
  cardRemoved: CARD_REMOVED,
  documentTypes: DOC_TYPES,
};

export { DocumentRefused };
