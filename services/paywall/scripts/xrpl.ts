/**
 * What the scripts share for the XRP Ledger: which network and account the
 * environment names, the ledger's reserves, and paying a paywall price in
 * RLUSD. The seed is read here and never printed or saved.
 *
 * The repository's .env is read when this file loads (src/env.ts), so no
 * script needs --env-file. A value already in the shell still wins, and is
 * reported by name when it does.
 *
 * XRPL_NETWORK                 testnet (default) or mainnet
 * <PREFIX>_<NETWORK>           the family seed (s...) of the account that signs;
 *                              PREFIX is XRPL_BUYER_SEED unless a script is given
 *                              another (the test rig gives one per tenant)
 * XRPL_WS_URL_<NETWORK>        the ledger's WebSocket address; TestNet has a default
 * RLUSD_ISSUER_<NETWORK>       the RLUSD issuer; TestNet has a default
 * RLUSD_CURRENCY_CODE          RLUSD's currency code; has a default
 *
 * Paying goes through a signer (scripts/signer.ts), not a Wallet: the
 * Payment is built by the same code as the web page's (services/web/src/xrpl-payment.ts),
 * signed by whichever signer the buyer has, and checked here before it is sent.
 */
import { isDeepStrictEqual } from "node:util";
import { Client, decode, verifySignature, Wallet } from "xrpl";
import { decodePaymentResponseHeader, type XRPLNetworkId } from "x402-xrpl";
import { LedgerError, type LedgerRequest } from "../../web/src/balance.ts";
import { decodeRequired, NOT_ON_LEDGER, paymentHeader, preparePayment } from "../../web/src/xrpl-payment.ts";
import { DEFAULT_RLUSD_CURRENCY_CODE, DEFAULT_RLUSD_ISSUER_TESTNET, NETWORKS, type NetworkName } from "../src/config.ts";
import { loadEnv } from "../src/env.ts";
import { seedSigner, type XrplSigner } from "./signer.ts";

// Every script reaches the ledger through this file, so the .env is read here,
// once, before any of them asks the environment for a seed or a server.
loadEnv();

export const DEFAULT_WS_URL_TESTNET = "wss://s.altnet.rippletest.net:51233/";

export type ScriptAccount = {
  networkName: NetworkName;
  /** CAIP-2 id: xrpl:1 or xrpl:0. */
  network: XRPLNetworkId;
  wsUrl: string;
  wallet: Wallet;
};

/** A problem with the environment; the scripts print the message and exit with 2. */
export class SetupError extends Error {}

export function networkName(env: Record<string, string | undefined>): NetworkName {
  const chosen = env.XRPL_NETWORK?.trim() || "testnet";
  if (!Object.hasOwn(NETWORKS, chosen)) throw new SetupError("XRPL_NETWORK must be testnet or mainnet");
  return chosen as NetworkName;
}

/** The prefix of the variable that holds a buyer's seed when a script names no other. */
export const DEFAULT_SEED_PREFIX = "XRPL_BUYER_SEED";

/** The name of the variable that holds the seed for the chosen network: PREFIX_TESTNET or PREFIX_MAINNET. */
export function seedVariable(env: Record<string, string | undefined>, seedPrefix: string = DEFAULT_SEED_PREFIX): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(seedPrefix)) throw new SetupError(`"${seedPrefix}" is not a valid seed variable prefix: use capital letters, digits and _, starting with a letter`);
  return `${seedPrefix}_${networkName(env).toUpperCase()}`;
}

export function wsUrl(env: Record<string, string | undefined>): string {
  const name = networkName(env);
  const variable = `XRPL_WS_URL_${name.toUpperCase()}`;
  const url = env[variable]?.trim() || (name === "testnet" ? DEFAULT_WS_URL_TESTNET : undefined);
  if (!url) throw new SetupError(`${variable} is required: the WebSocket address of an XRP Ledger server`);
  if (!/^wss?:\/\//.test(url) || !URL.canParse(url)) throw new SetupError(`${variable} must be a ws(s) URL`);
  return url;
}

/** RLUSD on the chosen network: its currency code and the account that issues it. */
export function rlusd(env: Record<string, string | undefined>): { currency: string; issuer: string } {
  const name = networkName(env);
  const variable = `RLUSD_ISSUER_${name.toUpperCase()}`;
  const issuer = env[variable]?.trim() || (name === "testnet" ? DEFAULT_RLUSD_ISSUER_TESTNET : undefined);
  if (!issuer) throw new SetupError(`${variable} is required: the RLUSD issuer, checked against Ripple's documentation`);
  return { currency: env.RLUSD_CURRENCY_CODE?.trim() || DEFAULT_RLUSD_CURRENCY_CODE, issuer };
}

export function account(env: Record<string, string | undefined>, options: { seedPrefix?: string } = {}): ScriptAccount {
  const name = networkName(env);
  const variable = seedVariable(env, options.seedPrefix);
  const seed = env[variable]?.trim();
  if (!seed) throw new SetupError(`${variable} is required: the account's family seed (s...)`);
  let wallet: Wallet;
  try {
    wallet = Wallet.fromSeed(seed);
  } catch {
    throw new SetupError(`${variable} is not a valid family seed`); // the cause is dropped: it can quote the seed
  }
  return { networkName: name, network: NETWORKS[name], wsUrl: wsUrl(env), wallet };
}

/** The XRP an account must keep: the base reserve, plus the owner reserve for each object it owns (a trust line is one). */
export async function reserves(client: Client): Promise<{ baseXrp: number; ownerXrp: number }> {
  const { result } = await client.request({ command: "server_info" });
  const ledger = result.info.validated_ledger;
  if (!ledger) throw new Error("the XRP Ledger server has no validated ledger yet; try again shortly");
  return { baseXrp: ledger.reserve_base_xrp, ownerXrp: ledger.reserve_inc_xrp };
}

/**
 * Ledger reads over one open xrpl.js connection, in the shape the payment code
 * takes. One connection serves every read of every payment a buyer makes:
 * the web page's reader opens a new WebSocket per read, which a public server
 * stops answering once several buyers do it at once. A server's refusal keeps
 * its code (actNotFound, ...); no answer at all is "unreachable".
 */
export function ledgerOverClient(client: Client): LedgerRequest {
  return async (command, params = {}) => {
    try {
      const reply = (await client.request({ command, ...params } as Parameters<Client["request"]>[0])) as { result?: unknown };
      return (reply.result ?? {}) as Record<string, unknown>;
    } catch (e) {
      const code = (e as { data?: { error?: unknown } } | undefined)?.data?.error;
      if (typeof code === "string" && code) throw new LedgerError(code, `the XRP Ledger server answered ${code}`);
      throw new LedgerError("unreachable", `the XRP Ledger server did not answer: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}

/** Open one connection to the ledger server, run `work` with it, and close it, whatever happens. */
export async function withLedger<T>(wsUrl: string, work: (ledger: LedgerRequest) => Promise<T>): Promise<T> {
  const client = new Client(wsUrl);
  try {
    await client.connect();
  } catch (e) {
    throw new LedgerError("unreachable", `cannot connect to the XRP Ledger server ${wsUrl}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return await work(ledgerOverClient(client));
  } finally {
    await client.disconnect();
  }
}

/** The part of an xrpl.js Client a warm ledger uses; a parameter so tests need no server. */
export type LedgerClient = Pick<Client, "connect" | "disconnect" | "isConnected" | "request">;

export type WarmLedger = {
  /** Ledger reads over the warm connection; each read first waits for the connection, reopening it once if it was lost. */
  ledger: LedgerRequest;
  /** Resolves when the first connection attempt has finished, whether it worked or not. */
  settled: Promise<void>;
  /** Close the connection, whatever state it is in. */
  close: () => Promise<void>;
};

/**
 * Open the ledger connection now, in the background, and hand back reads that
 * use it (P14 pre-warm). The buyer agent starts this before its first Bedrock
 * turn, so the connection is usually open by the time the tool pays, instead
 * of costing a connect inside the tool call. A failed connect is not thrown
 * here: the first read reports it as "unreachable", as withLedger does.
 */
export function warmLedger(wsUrl: string, deps: { client?: LedgerClient } = {}): WarmLedger {
  const client: LedgerClient = deps.client ?? new Client(wsUrl);
  let failure: unknown;
  const settled = client.connect().then(
    () => undefined,
    (e: unknown) => {
      failure = e;
    },
  );
  const reads = ledgerOverClient(client as Client);
  const ledger: LedgerRequest = async (command, params) => {
    await settled;
    if (!client.isConnected()) {
      try {
        await client.connect();
      } catch (e) {
        const cause = e ?? failure;
        throw new LedgerError("unreachable", `cannot connect to the XRP Ledger server ${wsUrl}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    return reads(command, params);
  };
  const close = async (): Promise<void> => {
    await settled;
    if (client.isConnected()) await client.disconnect();
  };
  return { ledger, settled, close };
}

/** Who pays: the network, the ledger server the payment is prepared from, and the signer. */
export type Buyer = { networkName: NetworkName; network: XRPLNetworkId; wsUrl: string; signer: XrplSigner };

/** A buyer whose payments are signed with the script account's seed. */
export function seedBuyer(a: ScriptAccount): Buyer {
  return { networkName: a.networkName, network: a.network, wsUrl: a.wsUrl, signer: seedSigner(a.wallet) };
}

/**
 * What a payAndFetch call returned. `amount` is the RLUSD price signed for,
 * present only when a payment was presented; `receipt` only when it settled;
 * `refusal` the paywall's stated reason when it answered a presented payment
 * with 402 again.
 */
export type Paid = { response: Response; amount?: string; refusal?: string; receipt?: { success: boolean; transaction: string; network: string; payer?: string | null } };

/**
 * The reason a paywall gives in its PAYMENT-REQUIRED header when it refuses a
 * payment (the x402 v2 `error` field), or undefined when it gives none.
 */
export function refusalReason(response: Response): string | undefined {
  const header = response.headers.get("payment-required");
  if (!header) return undefined;
  try {
    const error = (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { error?: unknown }).error;
    return typeof error === "string" && error ? error : undefined;
  } catch {
    return "the paywall's PAYMENT-REQUIRED header could not be read";
  }
}

/** The most decimals an RLUSD amount is compared with: the XRP Ledger keeps 15 significant digits. */
const DECIMALS = 15;
const DECIMAL = new RegExp(`^(0|[1-9]\\d*)(\\.\\d{1,${DECIMALS}})?$`);

/**
 * A decimal amount as a whole number of 10^-15 units, so amounts are added and
 * compared exactly, never as floating point.
 */
export function decimalUnits(amount: string): bigint {
  if (!DECIMAL.test(amount)) throw new SetupError(`"${amount}" is not a decimal amount with at most ${DECIMALS} decimals`);
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole) * 10n ** BigInt(DECIMALS) + BigInt(fraction.padEnd(DECIMALS, "0"));
}

/** The inverse of decimalUnits, without trailing zeros: 10^13 units is "0.01". */
export function unitsToDecimal(units: bigint): string {
  const scale = 10n ** BigInt(DECIMALS);
  const fraction = (units % scale).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return `${units / scale}${fraction ? `.${fraction}` : ""}`;
}

export type PayOptions = {
  /** Reads from the XRP Ledger server the payment is prepared from; by default one connection to the buyer's wsUrl, opened for this call. */
  ledger?: LedgerRequest;
  /** Refuse, before signing, a price above this RLUSD amount. */
  maxAmount?: string;
  /** Called as each payment phase ends with its name and milliseconds (scripts/timing.ts); never with any text. */
  onPhase?: (phase: string, ms: number) => void;
};

/**
 * Refuse a ledger server on another network than the one being paid: the
 * sequence and fee it gives would belong to the wrong ledger. The x402-xrpl
 * SDK's payer makes the same check before it signs.
 */
async function checkNetwork(ledger: LedgerRequest, buyer: Buyer): Promise<void> {
  const info = (await ledger("server_info")).info as { network_id?: unknown } | undefined;
  const expected = Number(buyer.network.slice("xrpl:".length));
  if (info?.network_id !== expected) {
    throw new SetupError(`the XRP Ledger server ${buyer.wsUrl} reports network ${String(info?.network_id ?? "unknown")}, not ${buyer.network}; nothing was paid`);
  }
}

/**
 * The signed transaction must be exactly the Payment that was prepared, from
 * the buyer's own account, with a signature that verifies. Checked before
 * anything is sent, whatever the signer is.
 */
function checkSigned(tx: Record<string, unknown>, signedTxBlob: string, address: string): void {
  let read: Record<string, unknown>;
  try {
    read = decode(signedTxBlob);
  } catch {
    throw new SetupError("the signer returned something that is not a signed XRP Ledger transaction; nothing was paid");
  }
  for (const [field, value] of Object.entries(tx)) {
    if (!isDeepStrictEqual(read[field], value)) throw new SetupError(`the signer changed the payment's ${field}; nothing was paid`);
  }
  if (read.Account !== address) throw new SetupError("the signer signed for another account; nothing was paid");
  let valid: boolean;
  try {
    valid = verifySignature(signedTxBlob);
  } catch {
    valid = false;
  }
  if (!valid) throw new SetupError("the payment's signature does not verify; nothing was paid");
}

/**
 * Call a paywall route and pay the price it asks: read the PAYMENT-REQUIRED
 * header, prepare one RLUSD Payment bound to its invoice, have the buyer's
 * signer sign it, check it, and call again with PAYMENT-SIGNATURE. The
 * paywall's facilitator submits the transaction only when the call is served.
 * A route that asks for no payment is returned as is. A price above
 * options.maxAmount is refused before anything is signed.
 */
export async function payAndFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
  buyer: Buyer,
  options: PayOptions = {},
): Promise<Paid> {
  if (!options.ledger) {
    const connecting = performance.now();
    return withLedger(buyer.wsUrl, (ledger) => {
      options.onPhase?.("ledger_connect", performance.now() - connecting);
      return payAndFetch(url, init, buyer, { ...options, ledger });
    });
  }
  const ledger = options.ledger;
  let mark = performance.now();
  const lap = (phase: string): void => {
    const now = performance.now();
    options.onPhase?.(phase, now - mark);
    mark = now;
  };
  const ceiling = options.maxAmount === undefined ? undefined : decimalUnits(options.maxAmount);
  const first = await fetch(url, init);
  lap("quote_402");
  const header = first.headers.get("payment-required");
  if (first.status !== 402 || !header) return { response: first };
  const required = decodeRequired(header);
  const offer = required.accepts.find((a) => a.scheme === "exact" && a.network === buyer.network);
  if (!offer) {
    const asked = required.accepts.map((a) => `${a.scheme} on ${a.network}`).join(", ");
    throw new SetupError(`the paywall asks for ${asked || "nothing this script can pay"}, but XRPL_NETWORK is ${buyer.networkName} (${buyer.network})`);
  }
  if (ceiling !== undefined && decimalUnits(offer.amount) > ceiling) {
    throw new SetupError(`the price ${offer.amount} RLUSD is above the most this buyer may pay now (${options.maxAmount} RLUSD); nothing was paid`);
  }
  mark = performance.now();
  await checkNetwork(ledger, buyer);
  lap("ledger_network");
  const address = buyer.signer.classicAddress;
  const tx = await preparePayment(address, offer, ledger).catch((e: unknown) => {
    if (!(e instanceof Error) || e.message !== NOT_ON_LEDGER) throw e;
    throw new SetupError(`the buyer account ${address} is not on ${buyer.networkName} yet: fund it with XRP and open its RLUSD trust line first; nothing was paid`);
  });
  lap("ledger_prepare");
  const { signedTxBlob } = await buyer.signer.sign(tx);
  checkSigned(tx, signedTxBlob, address);
  const payment = paymentHeader(offer, signedTxBlob, required.resource);
  lap("sign");
  const response = await fetch(url, { ...init, headers: { ...init.headers, "PAYMENT-SIGNATURE": payment } });
  lap("paid_call");
  const receipt = response.headers.get("payment-response");
  const refusal = response.status === 402 ? (refusalReason(response) ?? "the paywall asked for payment again and gave no reason") : undefined;
  return { response, amount: offer.amount, ...(refusal ? { refusal } : {}), receipt: receipt ? decodePaymentResponseHeader(receipt) : undefined };
}
