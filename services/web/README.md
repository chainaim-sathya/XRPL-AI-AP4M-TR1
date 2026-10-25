# PrivacyBuddy web

A page for private chat: type a message, see it masked on your own device, then
Execute to pay (RLUSD, x402) from your own Crossmark wallet and get the answer with
your original values put back. The buyer (your Crossmark account) and the pay-to
wallet show top right.

Masking runs in the browser with `services/paywall/scripts/client-mask.ts`.
Paying runs in the browser too: `public/wallet.js` holds the x402 client and
`@crossmarkio/sdk`, and Crossmark signs each payment after you approve it. The server
holds no wallet key. It relays the paid call to the paywall (`POST /api/chat`)
after checking the text has nothing left to mask, and never logs text,
placeholders, the restore map or the payment.

## Run it on your PC

1. Start the paywall first (the test console's `start.cmd` does, at
   http://127.0.0.1:8080).
2. Install the Crossmark extension in Chrome from https://crossmark.io, and
   make or import a TestNet account in it. There is no pop-up fallback: the
   page needs the extension.
3. Give that account TestNet XRP (https://xrpl.org/resources/dev-tools/xrp-faucets),
   open its RLUSD trust line (`node scripts/trust-line.ts` in
   `services/paywall`, or the wallet's own trust-line screen), and get
   TestNet RLUSD (https://tryrlusd.com/).
4. Start the page (PowerShell, from the repository folder):

   ```powershell
   $env:PAYWALL_URL = "http://127.0.0.1:8080"
   npm --prefix services/web start
   ```

Open http://127.0.0.1:8740, click **Connect Crossmark**, then Mask and Execute.
Crossmark asks you to approve each payment.

## Settings

| Variable | Meaning | Default |
|---|---|---|
| `PAYWALL_URL` | the paywall's address (required) | none |
| `PORT`, `HOST` | where to listen | `8740`, `127.0.0.1` |

## The browser bundle

`public/wallet.js` is built from `src/wallet-entry.ts` and committed. After
changing `src/wallet-entry.ts`, `src/crossmark-signer.ts`, `src/xrpl-payment.ts`, `src/balance.ts`,
`src/answer.ts`, `src/buffer-shim.ts`, `scripts/build-wallet.ts`, `package.json` or `package-lock.json`, rebuild it:

```bash
npm --prefix services/web run build:wallet
```

A test fails if the bundle is older than its sources.

## Deploy

The page deploys to Vercel and calls the paywall on Railway: see
`docs/deploy/vercel.md`. `vercel.json` and `npm run build:vercel` do the build.

## Tests

```bash
npm --prefix services/web test
```

The version of this page shown in the demo video (server-held demo wallet) is
the git tag `demo-video-v1`.
