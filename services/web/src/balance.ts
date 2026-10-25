/**
 * What a wallet holds, read from a public XRP Ledger server, and the
 * per-network constants the page and the payment need. No Node-only APIs: the
 * browser bundle (wallet-entry.ts) imports this file too.
 *
 * The ledger is read over WebSocket: the public JSON-RPC servers send no CORS
 * headers, so a page cannot call them with fetch.
 */
export type KnownNetwork = "testnet" | "mainnet";
export type Balance = { xrp: number; rlusd: number; trustLineOpen: boolean };
/** RLUSD is a currency code plus the account that issues it. */
export type Token = { currency: string; issuer: string };

export const NETWORKS: Record<KnownNetwork, { caip2: string; wsUrl: string }> = {
  testnet: { caip2: "xrpl:1", wsUrl: "wss://s.altnet.rippletest.net:51233/" },
  mainnet: { caip2: "xrpl:0", wsUrl: "wss://s1.ripple.com:51233/" },
};

/** One command to an XRP Ledger server. Resolves with its result; rejects with a LedgerError when the server refuses it. */
export type LedgerRequest = (command: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;

export class LedgerError extends Error {
  /** The server's error code, such as actNotFound, or "unreachable" when it did not answer. */
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Sends each command on its own WebSocket and closes it once the server has answered. */
export function ledgerOverWebSocket(wsUrl: string, timeoutMs = 8000): LedgerRequest {
  return (command, params = {}) =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      const finish = (settle: () => void): void => {
        clearTimeout(timer);
        socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
        if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close();
        settle();
      };
      const unreachable = (): void => finish(() => reject(new LedgerError("unreachable", "the XRP Ledger server did not answer")));
      const timer = setTimeout(unreachable, timeoutMs);
      socket.onopen = () => socket.send(JSON.stringify({ id: 1, command, ...params }));
      socket.onerror = unreachable;
      socket.onclose = unreachable;
      socket.onmessage = (event) => {
        let reply: { status?: unknown; result?: unknown; error?: unknown; error_message?: unknown };
        try {
          reply = JSON.parse(String(event.data));
        } catch {
          finish(() => reject(new LedgerError("unreadable", "the XRP Ledger server sent an answer that is not JSON")));
          return;
        }
        if (reply.status === "success" && typeof reply.result === "object" && reply.result !== null) {
          finish(() => resolve(reply.result as Record<string, unknown>));
        } else {
          const code = typeof reply.error === "string" ? reply.error : "unknown";
          finish(() => reject(new LedgerError(code, `the XRP Ledger server answered ${typeof reply.error_message === "string" ? reply.error_message : code}`)));
        }
      };
    });
}

export async function readBalance(address: string, network: KnownNetwork, token: Token, request: LedgerRequest = ledgerOverWebSocket(NETWORKS[network].wsUrl)): Promise<Balance> {
  let info: Record<string, unknown>;
  try {
    info = await request("account_info", { account: address, ledger_index: "validated" });
  } catch (e) {
    // An address that was never funded is not on the ledger: it holds nothing.
    if (e instanceof LedgerError && e.code === "actNotFound") return { xrp: 0, rlusd: 0, trustLineOpen: false };
    throw e;
  }
  const drops = Number((info.account_data as { Balance?: unknown } | undefined)?.Balance);
  if (!Number.isFinite(drops)) throw new Error("the XRP Ledger server's account answer is not in the expected shape");
  const lines = ((await request("account_lines", { account: address, peer: token.issuer, ledger_index: "validated" })).lines ?? []) as { currency?: unknown; balance?: unknown }[];
  const line = lines.find((l) => l.currency === token.currency);
  // XRP is counted in drops, a million to one XRP. An RLUSD balance is already a decimal.
  return { xrp: drops / 1e6, rlusd: line ? Number(line.balance) : 0, trustLineOpen: line !== undefined };
}
