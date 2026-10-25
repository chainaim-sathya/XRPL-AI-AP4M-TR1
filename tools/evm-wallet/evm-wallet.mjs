/**
 * XRPL EVM Sidechain wallet: create one, show its address, check XRP (gas) and RLUSD balances.
 * The private key is written to --key-file (outside every repository) and is NEVER printed.
 *
 *   node evm-wallet.mjs --step create  --prefix EVM_B01 --key-file C:\PRIV-AI-SECRETS\evm-wallets.env [--network testnet]
 *   node evm-wallet.mjs --step address --prefix EVM_B01 --key-file C:\PRIV-AI-SECRETS\evm-wallets.env
 *   node evm-wallet.mjs --step balance --prefix EVM_B01 --key-file C:\PRIV-AI-SECRETS\evm-wallets.env [--rlusd-contract 0x...]
 *
 * --network testnet|mainnet   (default testnet)
 *   testnet: RPC https://rpc.testnet.xrplevm.org, chain 1449000, explorer https://explorer.testnet.xrplevm.org
 *   mainnet: RPC https://rpc.xrplevm.org, chain 1440000, explorer https://explorer.xrplevm.org
 *   (docs.xrplevm.org "Deploy the Smart Contract", read 2026-10-24)
 * --rpc URL                   override the RPC endpoint
 * --rlusd-contract 0x...      RLUSD token on this network. Mainnet default: 0x8d58c0c60b8d6b88fa98b291a646db34d0f98258 (Ripple's
 *                             token-addresses page lists it for "the XRPL EVM Sidechain", read 2026-10-24). Testnet: Ripple lists
 *                             no RLUSD address, so there is no default; pass one if you have it.
 * --prefix NAME               variable name prefix: the key is saved as <PREFIX>_<NETWORK>_KEY, the address as a comment
 * --key-file FILE             where the key is saved; must exist outside any git repository; created if missing
 */
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Wallet, JsonRpcProvider, Contract, formatEther, formatUnits } from "ethers";

const NETS = {
  testnet: { rpc: "https://rpc.testnet.xrplevm.org", chainId: 1449000, explorer: "https://explorer.testnet.xrplevm.org", rlusd: null, faucet: "https://faucet.xrplevm.org" },
  mainnet: { rpc: "https://rpc.xrplevm.org", chainId: 1440000, explorer: "https://explorer.xrplevm.org", rlusd: "0x8d58c0c60b8d6b88fa98b291a646db34d0f98258", faucet: null },
};
const { values: f } = parseArgs({ strict: true, options: {
  step: { type: "string" }, prefix: { type: "string" }, "key-file": { type: "string" }, network: { type: "string", default: "testnet" },
  rpc: { type: "string" }, "rlusd-contract": { type: "string" },
} });
const fail = (m) => { console.error(`evm-wallet: ${m}`); process.exit(2); };
if (!["create", "address", "balance"].includes(f.step ?? "")) fail("--step must be create, address or balance");
if (!/^[A-Z][A-Z0-9_]{1,40}$/.test(f.prefix ?? "")) fail("--prefix must be an UPPER_CASE name, e.g. EVM_B01");
const net = NETS[f.network] ?? fail("--network must be testnet or mainnet");
if (!f["key-file"]) fail("--key-file is required (outside every repository)");
const envFile = resolve(f["key-file"]);
// Refuse a file inside a git repository (any parent folder holding .git).
for (let d = dirname(envFile); ; d = dirname(d)) { if (existsSync(resolve(d, ".git"))) fail(`${envFile} is inside a git repository (${d}); keep keys outside every repo`); if (dirname(d) === d) break; }
const varName = `${f.prefix}_${f.network.toUpperCase()}_KEY`;
const readKey = () => {
  if (!existsSync(envFile)) return undefined;
  const line = readFileSync(envFile, "utf8").split(/\r?\n/).find((l) => l.startsWith(`${varName}=`));
  return line ? line.slice(varName.length + 1).trim() : undefined;
};

if (f.step === "create") {
  if (readKey()) fail(`${varName} already exists in ${envFile}; use another --prefix`);
  const w = Wallet.createRandom();
  const text = `# ${f.prefix} XRPL EVM ${f.network} address ${w.address} (created ${new Date().toISOString()})\n${varName}=${w.privateKey}\n`;
  if (existsSync(envFile)) appendFileSync(envFile, text, { encoding: "utf8" }); else writeFileSync(envFile, text, { encoding: "utf8", mode: 0o600 });
  console.log(`created   ${w.address}  (XRPL EVM ${f.network}, chain ${net.chainId})`);
  console.log(`key       saved as ${varName} in ${envFile} (not shown)`);
  console.log(`explorer  ${net.explorer}/address/${w.address}`);
  if (net.faucet) console.log(`fund      open ${net.faucet}, choose Testnet, paste the address above (test XRP for gas)`);
  process.exit(0);
}
const key = readKey() ?? fail(`no ${varName} in ${envFile}; run --step create first`);
const wallet = new Wallet(key);
console.log(`address   ${wallet.address}  (XRPL EVM ${f.network})`);
if (f.step === "address") process.exit(0);

const provider = new JsonRpcProvider(f.rpc ?? net.rpc, net.chainId, { staticNetwork: true });
const xrp = await provider.getBalance(wallet.address);
console.log(`XRP       ${formatEther(xrp)} (gas token, 18 decimals)`);
const token = f["rlusd-contract"] ?? net.rlusd;
if (!token) { console.log("RLUSD     no RLUSD contract known for this network (Ripple lists none for the XRPL EVM testnet); pass --rlusd-contract 0x..."); process.exit(0); }
if (!/^0x[0-9a-fA-F]{40}$/.test(token)) fail("--rlusd-contract must be a 0x address");
const erc20 = new Contract(token, ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"], provider);
const [bal, dec, sym] = await Promise.all([erc20.balanceOf(wallet.address), erc20.decimals(), erc20.symbol()]);
console.log(`${sym.padEnd(9)} ${formatUnits(bal, dec)} (token ${token})`);
