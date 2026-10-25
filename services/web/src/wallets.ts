/**
 * Reads that feed the wallet chips: what the paywall asks for (pay-to address,
 * network, RLUSD currency code and issuer, price), taken from its own 402 quote. The wallet balance
 * read lives in balance.ts, which the browser also uses.
 */
import { NETWORKS } from "./balance.ts";

export type Quote = { payTo: string; network: string; asset: string; issuer: string; price: number };
export type NetworkName = "testnet" | "mainnet" | "unknown";

export function networkName(caip2: string): NetworkName {
  if (caip2 === NETWORKS.testnet.caip2) return "testnet";
  if (caip2 === NETWORKS.mainnet.caip2) return "mainnet";
  return "unknown";
}

/** Ask a paid route for its price without paying: the paywall answers 402 with the quote in a header. */
export async function readQuote(paywallUrl: string, route: string, fetcher: typeof fetch = fetch): Promise<Quote> {
  const r = await fetcher(paywallUrl + route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hi", messages: [{ role: "user", content: "hi" }] }),
    signal: AbortSignal.timeout(8000),
  });
  const header = r.headers.get("payment-required");
  if (r.status !== 402 || !header) throw new Error(`the paywall did not quote a price (HTTP ${r.status})`);
  const accepts = (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts?: Record<string, unknown>[] }).accepts?.[0];
  const issuer = (accepts?.extra as { issuer?: unknown } | null | undefined)?.issuer;
  if (!accepts || typeof accepts.payTo !== "string" || typeof accepts.network !== "string" || typeof accepts.asset !== "string" || typeof issuer !== "string" || !Number.isFinite(Number(accepts.amount))) {
    throw new Error("the paywall's quote is not in the expected shape");
  }
  // An RLUSD amount is already a decimal: "0.01" is one cent. It is not a count of micro-units, so it is not divided.
  return { payTo: accepts.payTo, network: accepts.network, asset: accepts.asset, issuer, price: Number(accepts.amount) };
}

/** The CAIP-2 id and the public XRP Ledger server for a known network. */
export function networkInfo(name: NetworkName): { caip2: string; wsUrl: string } | null {
  return name === "unknown" ? null : NETWORKS[name];
}
