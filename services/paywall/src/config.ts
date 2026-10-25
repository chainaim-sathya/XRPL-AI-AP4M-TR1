/**
 * Paywall configuration from the environment (spec sections 9 and 10). The
 * gateway key is the only secret, and it is never logged.
 */
import { isValidClassicAddress } from "ripple-address-codec";

/** XRPL_NETWORK picks one of these; the value is the CAIP-2 id used unless XRPL_CAIP2_<NETWORK> is set. */
export const NETWORKS = {
  testnet: "xrpl:1",
  mainnet: "xrpl:0",
} as const;
export type NetworkName = keyof typeof NETWORKS;

/** The t54 facilitator, used unless FACILITATOR_URL_<NETWORK> is set. */
export const DEFAULT_FACILITATORS: Record<NetworkName, string> = {
  testnet: "https://xrpl-facilitator-testnet.t54.ai",
  mainnet: "https://xrpl-facilitator-mainnet.t54.ai",
};
/** RLUSD's 160-bit currency code, the same on every network. */
export const DEFAULT_RLUSD_CURRENCY_CODE = "524C555344000000000000000000000000000000";
/** Ripple's TestNet RLUSD issuer. MainNet has no default: RLUSD_ISSUER_MAINNET is checked against Ripple's documentation at deploy time. */
export const DEFAULT_RLUSD_ISSUER_TESTNET = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
export const DEFAULT_SOURCE_TAG = 804681468;
export const DEFAULT_MAX_TIMEOUT_SECONDS = 600;

/** The paid routes, each priced by its own variable (PRICE_SCAN, PRICE_MASK, PRICE_CHAT). */
export const PRICED = ["scan", "mask", "chat"] as const;
export type Priced = (typeof PRICED)[number];
/** Used for any route whose PRICE_* variable is unset. */
export const DEFAULT_PRICE = "$0.01";

export type PaywallConfig = {
  network: string;
  networkName: NetworkName;
  /** The one XRPL account every route pays; it holds a trust line to the RLUSD issuer. */
  payTo: string;
  facilitatorUrl: string;
  /** RLUSD on the XRP Ledger is a currency code plus the account that issues it. */
  currencyCode: string;
  issuer: string;
  /** Put on every signed payment; the facilitator uses it for attribution. */
  sourceTag: number;
  /** How long a quoted payment stays payable, and how long its invoice stays open. */
  maxTimeoutSeconds: number;
  /** The private gateway, e.g. http://gateway.railway.internal:8700 */
  gatewayUrl: string;
  gatewayKey: string;
  /** How long a proxied call may take; chat can try three models. */
  gatewayTimeoutMs: number;
  port: number;
  host: string;
  /** Public origin such as https://pay.example.com: the resource URL in 402s and the Bazaar. */
  publicBaseUrl: string | undefined;
  /** USD price per call, e.g. "$0.01"; changeable without a code change. */
  prices: Record<Priced, string>;
  /**
   * PAYWALL_PHASE_LOG=on (default off): each payment_settled line also carries
   * `phases` with capacity_ms, verify_ms, gateway_ms and settle_ms (P14).
   * Names and whole milliseconds only, never text.
   */
  phaseLog?: boolean;
};

export function loadConfig(env: Record<string, string | undefined>): PaywallConfig {
  const value = (name: string): string | undefined => env[name]?.trim() || undefined;
  const required = (name: string): string => {
    const v = value(name);
    if (!v) throw new Error(`${name} is required`);
    return v;
  };
  const integer = (name: string, fallback: number): number => {
    const v = value(name);
    const n = v === undefined ? fallback : Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number, got ${v}`);
    return n;
  };
  /** A USD price with at most 6 decimals, above zero. RLUSD is a dollar stablecoin, so the same number is the RLUSD amount. */
  const price = (name: string): string => {
    const v = value(name) ?? DEFAULT_PRICE;
    if (!/^\$(0|[1-9]\d*)(\.\d{1,6})?$/.test(v) || Number(v.slice(1)) <= 0) {
      throw new Error(`${name} must be a USD price above zero such as $0.01, got ${v}`);
    }
    return v;
  };

  /** An XRPL classic address; the base58 checksum is verified, so a mistyped address fails here and not at settlement. */
  const address = (name: string, v: string): string => {
    if (!isValidClassicAddress(v)) throw new Error(`${name} must be an XRPL classic address (r...) with a valid checksum`);
    return v;
  };
  const url = (name: string, v: string): string => {
    const trimmed = v.replace(/\/+$/, "");
    if (!/^https?:\/\//.test(trimmed) || !URL.canParse(trimmed)) throw new Error(`${name} must be an http(s) URL`);
    return trimmed;
  };

  const chosen = value("XRPL_NETWORK") ?? "testnet";
  if (!Object.hasOwn(NETWORKS, chosen)) throw new Error("XRPL_NETWORK must be testnet or mainnet");
  const networkName = chosen as NetworkName;
  // Only the chosen network's variables are read, so the other network's may stay blank.
  const suffix = networkName.toUpperCase();
  const network = value(`XRPL_CAIP2_${suffix}`) ?? NETWORKS[networkName];
  if (!/^xrpl:\d+$/.test(network)) throw new Error(`XRPL_CAIP2_${suffix} must be a CAIP-2 id such as ${NETWORKS[networkName]}, got ${network}`);
  const payTo = address(`XRPL_PAY_TO_${suffix}`, required(`XRPL_PAY_TO_${suffix}`));
  const issuerName = `RLUSD_ISSUER_${suffix}`;
  const issuer = address(issuerName, networkName === "testnet" ? (value(issuerName) ?? DEFAULT_RLUSD_ISSUER_TESTNET) : required(issuerName));
  const currencyCode = value("RLUSD_CURRENCY_CODE") ?? DEFAULT_RLUSD_CURRENCY_CODE;
  if (!/^[0-9A-F]{40}$/.test(currencyCode)) throw new Error("RLUSD_CURRENCY_CODE must be 40 uppercase hex characters");
  const facilitatorUrl = url(`FACILITATOR_URL_${suffix}`, value(`FACILITATOR_URL_${suffix}`) ?? DEFAULT_FACILITATORS[networkName]);
  const sourceTag = integer("XRPL_SOURCE_TAG", DEFAULT_SOURCE_TAG);
  if (sourceTag > 0xffffffff) throw new Error("XRPL_SOURCE_TAG must fit in 32 bits");
  const maxTimeoutSeconds = integer("XRPL_MAX_TIMEOUT_SECONDS", DEFAULT_MAX_TIMEOUT_SECONDS);
  if (maxTimeoutSeconds === 0) throw new Error("XRPL_MAX_TIMEOUT_SECONDS must be above zero");
  const gatewayUrl = url("GATEWAY_URL", required("GATEWAY_URL"));
  const phaseLogValue = value("PAYWALL_PHASE_LOG") ?? "off";
  if (phaseLogValue !== "on" && phaseLogValue !== "off") throw new Error(`PAYWALL_PHASE_LOG must be on or off, got ${phaseLogValue}`);
  const publicBaseUrl = value("PUBLIC_BASE_URL")?.replace(/\/+$/, "");
  if (publicBaseUrl !== undefined && (!publicBaseUrl.startsWith("https://") || !URL.canParse(publicBaseUrl))) {
    throw new Error("PUBLIC_BASE_URL must be an https URL");
  }
  return {
    network,
    networkName,
    payTo,
    facilitatorUrl,
    currencyCode,
    issuer,
    sourceTag,
    maxTimeoutSeconds,
    gatewayUrl,
    gatewayKey: required("CHAINAIM_GATEWAY_KEY"),
    gatewayTimeoutMs: integer("GATEWAY_TIMEOUT_MS", 200_000),
    port: integer("PORT", 8080),
    host: value("HOST") ?? "0.0.0.0",
    publicBaseUrl,
    prices: { scan: price("PRICE_SCAN"), mask: price("PRICE_MASK"), chat: price("PRICE_CHAT") },
    phaseLog: phaseLogValue === "on",
  };
}
