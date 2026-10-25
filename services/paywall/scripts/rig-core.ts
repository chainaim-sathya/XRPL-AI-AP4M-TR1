/**
 * The test rig's logic: several tenants, each with its own XRP Ledger wallet,
 * pay a paywall route in RLUSD again and again, as many agents would. The
 * command line is scripts/rig.ts; this file holds what it runs, so the tests
 * can drive it in-process against a stub paywall and a stub ledger.
 *
 * A tenant is a folder: tenant.json names it and the variable prefix its
 * seed is read from (never the seed), and queries.json holds the texts it
 * sends. Every text is masked on this machine first (scripts/client-mask.ts),
 * exactly as private-ask.ts does, and refused if the masked text still holds
 * something that should have been masked.
 *
 * One payment from a wallet at a time: each XRP Ledger account numbers its
 * transactions, so a tenant's calls run one after another while tenants run
 * side by side. Each tenant has a spending ceiling, checked before every
 * payment is signed.
 *
 * Records written per call carry the tenant, payer address, status, amount and
 * transaction: never a seed, a request text or an answer.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { detect, maskText } from "./client-mask.ts";
import { decimalUnits, payAndFetch, SetupError, unitsToDecimal, type Buyer, type PayOptions } from "./xrpl.ts";

export const ENDPOINTS = { scan: "/v1/privacy/scan", mask: "/v1/privacy/mask", chat: "/v1/chat/completions" } as const;
export type Endpoint = keyof typeof ENDPOINTS;
/** The gateway's limits: 48,000 characters of chat text; 20,000 for scan and mask. */
const LIMITS: Record<Endpoint, number> = { chat: 48_000, scan: 20_000, mask: 20_000 };

export type Tenant = { id: string; name: string; seedPrefix: string; queries: string[] };

function readJson(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new SetupError(`cannot read ${path}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new SetupError(`${path} is not valid JSON: ${(e as Error).message}`);
  }
}

/**
 * The tenants under `dir`, in folder-name order: every folder holding a
 * tenant.json, or only those named in `only`. A folder's id must match its
 * tenant.json id, so a copied folder cannot silently pay as another tenant.
 */
export function loadTenants(dir: string, only?: readonly string[]): Tenant[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory()).sort();
  } catch (e) {
    throw new SetupError(`cannot read the tenants folder ${dir}: ${(e as Error).message}`);
  }
  if (only) {
    const missing = only.filter((id) => !names.includes(id));
    if (missing.length > 0) throw new SetupError(`no tenant folder for ${missing.join(", ")} in ${dir}`);
    names = names.filter((n) => only.includes(n));
  }
  const tenants = names.map((folder): Tenant => {
    const t = readJson(join(dir, folder, "tenant.json")) as { id?: unknown; name?: unknown; seedPrefix?: unknown };
    if (t.id !== folder) throw new SetupError(`${folder}/tenant.json: "id" must be "${folder}", the folder's name`);
    if (typeof t.name !== "string" || !t.name.trim()) throw new SetupError(`${folder}/tenant.json: "name" is required`);
    if (typeof t.seedPrefix !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(t.seedPrefix)) {
      throw new SetupError(`${folder}/tenant.json: "seedPrefix" must be a variable name prefix such as XRPL_SEED_T01 (capital letters, digits, _)`);
    }
    const q = readJson(join(dir, folder, "queries.json"));
    if (!Array.isArray(q) || q.length === 0 || !q.every((s) => typeof s === "string" && s.trim() !== "")) {
      throw new SetupError(`${folder}/queries.json must be a non-empty list of texts`);
    }
    return { id: folder, name: t.name, seedPrefix: t.seedPrefix, queries: q as string[] };
  });
  if (tenants.length === 0) throw new SetupError(`no tenants in ${dir}: each tenant is a folder with tenant.json and queries.json`);
  return tenants;
}

/** Two tenants sharing one wallet would race for its transaction numbers. */
export function checkDistinct(buyers: readonly { tenant: Tenant; buyer: Buyer }[]): void {
  const seen = new Map<string, string>();
  for (const { tenant, buyer } of buyers) {
    const other = seen.get(buyer.signer.classicAddress);
    if (other) throw new SetupError(`tenants ${other} and ${tenant.id} use the same account ${buyer.signer.classicAddress}; give each its own seed`);
    seen.set(buyer.signer.classicAddress, tenant.id);
  }
}

export type Prepared = { bodyText: string; counts: Record<string, number> };

/**
 * Mask one text on this machine and build the request body for the endpoint.
 * Throws a SetupError when the masked text still holds a value that should be
 * masked, or is too long: nothing is sent and nothing is paid.
 */
export function prepareRequest(endpoint: Endpoint, text: string, maxTokens: number): Prepared {
  const { masked, counts } = maskText(text);
  if (detect(masked).length > 0) throw new SetupError("the masked text still holds a value that should be masked; nothing was sent");
  if (masked.length > LIMITS[endpoint]) throw new SetupError(`the text is ${masked.length} characters after masking; ${endpoint} takes at most ${LIMITS[endpoint]}; nothing was sent`);
  const body = endpoint === "chat" ? { model: "chainaim/auto", messages: [{ role: "user", content: masked }], max_tokens: maxTokens } : { text: masked };
  return { bodyText: JSON.stringify(body), counts };
}

export type RunOptions = {
  /** The paywall's base address, without a trailing slash. */
  url: string;
  endpoint: Endpoint;
  /** Calls per tenant. */
  calls: number;
  /** Pause between one tenant's calls. */
  intervalMs: number;
  /** The most RLUSD one tenant may spend in this run. */
  maxSpend: string;
  /** Longest chat answer. */
  maxTokens: number;
};

export type CallResult = "settled" | "not_settled" | "refused_local" | "stopped" | "error";

export type CallRecord = {
  ts: string;
  tenant: string;
  payer: string;
  call: number;
  endpoint: Endpoint;
  result: CallResult;
  status?: number;
  amount?: string;
  transaction?: string;
  network?: string;
  latencyMs: number;
  masked?: Record<string, number>;
  error?: string;
};

export type TenantSummary = { tenant: string; payer: string; settled: number; notSettled: number; refused: number; errors: number; spent: string; stoppedBy?: string };

export type TenantDeps = {
  /** Called once per call record. */
  write: (record: CallRecord) => void;
  /** Passed to payAndFetch: a ledger stand-in in tests, the buyer's server otherwise. */
  ledger?: PayOptions["ledger"];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run one tenant's calls in order. A SetupError (budget reached, account not
 * funded, wrong network, a signer problem) stops this tenant; any other error
 * is recorded and the next call goes ahead.
 */
export async function runTenant(tenant: Tenant, buyer: Buyer, options: RunOptions, deps: TenantDeps): Promise<TenantSummary> {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const budget = decimalUnits(options.maxSpend);
  let spent = 0n;
  const summary: TenantSummary = { tenant: tenant.id, payer: buyer.signer.classicAddress, settled: 0, notSettled: 0, refused: 0, errors: 0, spent: "0" };
  const url = `${options.url}${ENDPOINTS[options.endpoint]}`;

  for (let call = 1; call <= options.calls; call++) {
    if (call > 1 && options.intervalMs > 0) await sleep(options.intervalMs);
    const started = now();
    const base = { tenant: tenant.id, payer: buyer.signer.classicAddress, call, endpoint: options.endpoint };
    const record = (fields: Omit<CallRecord, keyof typeof base | "ts" | "latencyMs">): CallRecord => ({ ts: new Date().toISOString(), ...base, ...fields, latencyMs: now() - started });

    let prepared: Prepared;
    try {
      prepared = prepareRequest(options.endpoint, tenant.queries[(call - 1) % tenant.queries.length], options.maxTokens);
    } catch (e) {
      if (!(e instanceof SetupError)) throw e;
      summary.refused++;
      deps.write(record({ result: "refused_local", error: e.message }));
      continue;
    }

    try {
      const paid = await payAndFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: prepared.bodyText }, buyer, {
        ledger: deps.ledger,
        maxAmount: unitsToDecimal(budget - spent),
      });
      // The body is read so the connection is released; it is never recorded.
      await paid.response.arrayBuffer();
      const settled = paid.response.ok && paid.receipt?.success === true && paid.amount !== undefined;
      if (settled) {
        spent += decimalUnits(paid.amount!);
        summary.settled++;
      } else {
        summary.notSettled++;
      }
      deps.write(
        record({
          result: settled ? "settled" : "not_settled",
          status: paid.response.status,
          ...(paid.amount !== undefined ? { amount: paid.amount } : {}),
          ...(paid.receipt?.transaction ? { transaction: paid.receipt.transaction } : {}),
          ...(paid.receipt?.network ? { network: paid.receipt.network } : {}),
          ...(paid.refusal ? { error: `refused by the paywall: ${paid.refusal}` } : {}),
          masked: prepared.counts,
        }),
      );
    } catch (e) {
      if (e instanceof SetupError) {
        summary.stoppedBy = e.message;
        deps.write(record({ result: "stopped", error: e.message, masked: prepared.counts }));
        break;
      }
      summary.errors++;
      deps.write(record({ result: "error", error: e instanceof Error ? e.message : String(e), masked: prepared.counts }));
    }
  }
  summary.spent = unitsToDecimal(spent);
  return summary;
}
