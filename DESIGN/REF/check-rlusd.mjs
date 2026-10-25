import * as fs from 'node:fs';
import { Client, Wallet } from 'xrpl';

const env = Object.fromEntries(
  fs.readFileSync('.env','utf8').split('\n').filter(Boolean).map(l => {
    const i = l.indexOf('='); return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^"|"$/g,'')];
  })
);
const ISSUER = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';
const CURRENCY = '524C555344000000000000000000000000000000';

const w = Wallet.fromSeed(env.XRPL_SEED);
const client = new Client('wss://s.altnet.rippletest.net:51233');
await client.connect();
try {
  const iss = await client.request({ command:'account_info', account: ISSUER, ledger_index:'validated' });
  console.log('issuer exists  : yes ✓  ' + ISSUER);
  console.log('issuer flags   : ' + iss.result.account_data.Flags);
  const dom = iss.result.account_data.Domain;
  console.log('issuer domain  : ' + (dom ? Buffer.from(dom,'hex').toString('utf8') : '—'));

  const lines = await client.request({ command:'account_lines', account: w.classicAddress, ledger_index:'validated' });
  console.log('');
  console.log('our address    : ' + w.classicAddress);
  console.log('trust lines    : ' + (lines.result.lines.length || 'none'));
  for (const l of lines.result.lines) console.log('   ' + l.currency + ' / ' + l.account + ' bal=' + l.balance + ' limit=' + l.limit);
  console.log('');
  console.log('currency hex   : ' + CURRENCY);
  console.log('decodes to     : ' + Buffer.from(CURRENCY,'hex').toString('utf8').replace(/\0+$/,''));
} finally { await client.disconnect(); }
