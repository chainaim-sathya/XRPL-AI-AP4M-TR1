// Generate an XRPL EVM Testnet (chain 1449000) agent wallet for AP4M.
// The private key goes straight to .env and is never printed.
import * as fs from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const env = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
if (/^\s*AGENT_PRIVATE_KEY\s*=/m.test(env)) {
  console.error('AGENT_PRIVATE_KEY already set in .env — aborting.');
  process.exit(1);
}
const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);
const prefix = env.length && !env.endsWith('\n') ? '\n' : '';
fs.appendFileSync('.env', `${prefix}AGENT_PRIVATE_KEY="${pk}"\n`, 'utf8');
console.log('chain          : XRPL EVM Testnet (1449000)');
console.log('agent address  : ' + account.address);
console.log('private key    : saved to .env as AGENT_PRIVATE_KEY (not printed)');
