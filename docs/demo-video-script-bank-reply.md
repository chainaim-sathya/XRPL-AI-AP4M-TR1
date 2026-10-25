# PrivacyBuddy: "reply to your bank" video script (draft for approval)

Replaces the loan-officer story in `demo-video-script-lending.md`. Audience: anyone who gets emails from a bank, lender or insurer and uses AI to write the reply. Story: a customer gets a message from their bank, lets AI draft the reply, and the AI never sees the name, account number or PAN.

Target length 1:45 to 1:55. About 270 words of voiceover. One screen: the PrivacyBuddy page.

**Line for the title card and the description:** Prepare your replies to financial emails without sharing anything sensitive.

## 0:00 to 0:15: the hook

**Screen:** a phone notification, "Your bank: EMI auto-debit failed". Then an AI chat box with the bank's email pasted in, and NAME, ACCOUNT, IFSC and PAN flagged in red.

> Your bank just emailed you. You want AI to write the reply. So you paste the whole thing in: your name, your account number, your PAN. Your bank needs those details. The AI does not.

## 0:15 to 0:40: mask it

**Screen:** the page; press **Try an example**. The bank's email and the request fill in and are masked. The pills read "1 name hidden", "1 bank account number hidden", "1 bank IFSC code hidden", "1 PAN number hidden", "1 phone number hidden", "1 email address hidden".

> Meet PrivacyBuddy. Paste the bank's message, say what you want to reply, and click Mask. Right in your browser, your name, account number, IFSC code, PAN, phone and email turn into placeholders. Nothing has left your computer. Nothing has been spent.

## 0:40 to 1:00: one cent, no sign-up

**Screen:** point at **Execute · $0.01** and the wallet chips; the Lute approval. Optional: an unmasked email being refused with "Mask it first. Nothing was sent or paid."

> Now click Execute. One cent per answer, in USDC on Algorand. No sign-up, no subscription, no API key. You approve each payment in your own wallet. And if you forget to mask an email address or a card number, the service refuses it. Nothing sent, nothing paid.

## 1:00 to 1:25: the reply

**Screen:** the answer appears with the real values restored and highlighted; the receipt row with its link to the public ledger.

> The model writes your reply using the placeholders. Your browser puts the real details back, so the reply is ready to copy and send to your bank. The receipt is one click away on the public ledger. It shows the payment, never the message.

## 1:25 to 1:45: why it matters

**Screen:** three cards fade in: "Masked before it leaves", "One cent per answer", "Your details go to your bank, not the AI".

> Loan queries. Failed payments. Insurance claims. Tax notices. Let AI do the writing, and keep your details out of it.

## 1:45 to 1:55: close

**Screen:** the headline and the wallet chips; small closing line: "Experimental beta · built for the Global x402 Challenge · tested only in India".

> PrivacyBuddy. Reply to your bank, not to the whole internet.

## Other lines you can swap in

- Your bank needs your details. The AI does not.
- Mask it. Ask it. Send it.
- AI writes the reply. Your details stay home.
- Share the question, not the account number.
- One cent for the answer. Zero details given away.

## The sample message (paste this, it is checked)

```
Dear Mr Rohan Mehta,
Your EMI auto-debit of INR 18,450 for home loan HL-2041 from account 123456789012 (IFSC ABCD0001234) did not go through on 28 September. Please reply to confirm a new date.
Loans Desk

My details for the reply:
PAN: ABCPM1234K
Phone: +91 98765 43210
Email: rohan.mehta@example.com

Write a short, polite reply to my bank. Quote my details and ask them to retry the debit on 5 October.
```

Run through the masker on 2026-10-03: name, bank account, IFSC, PAN, phone and email each became one placeholder. The loan number HL-2041, the amount and the dates stay visible, which is what the model needs to write the reply.

## Every spoken claim and its evidence

| Claim | Evidence |
|---|---|
| Name, account number, IFSC, PAN, phone and email become placeholders | The masker run on the sample above (`services/paywall/scripts/client-mask.ts`) |
| Nothing has left the computer at the Mask step | `doMask` in `index.html` makes no network call |
| One cent per answer, USDC on Algorand | The live 402 quote: 10000 micro-USDC, scheme exact |
| No sign-up, no API key | The page says "no sign-up needed"; the wallet is the only login |
| You approve each payment in your own wallet | `services/web/README.md` (Lute asks for each one) |
| An unmasked email address or card number is refused, nothing sent or paid | `checkChat` in `services/web/src/relay.ts`; live 400 for an email and a card number |
| The model uses placeholders; the browser restores them | The map stays in the browser; `restore()` runs on the answer |
| The receipt shows the payment, never the message | The on-chain note is `x402-payment-v2-<number>`, no message text |

## Before you record

- **Do not say "credentials" or "passwords".** The masker does not detect passwords, OTPs, PINs, CVVs or net-banking user IDs, so none of them may appear in the sample or the voiceover. The script says "details" throughout. No real bank asks for those by email either, so showing one would look like a phishing reply.
- **The name is hidden because it follows "Mr".** A bare name with no "Mr", "Ms", "Name:" or similar before it is not hidden in the browser. Keep "Dear Mr Rohan Mehta" in the sample.
- **Card numbers are removed, not restored.** If the sample had a card number the reply would come back with "[CARD REMOVED]". The sample has none; keep it that way.
- **Not covered by the masker, so never put these in the sample:** street address, date of birth, UPI ID, GSTIN, passport number, customer ID.
- **"Try an example" now loads this sample** in the local code (`EXAMPLE` in `services/web/public/index.html` and `services/web/test/mask.test.ts`). The live site shows it only after the change is pushed and deployed.
- **The live site is on MainNet.** Pressing Execute spends a real cent from your Lute wallet.
- **Recreated screens are fine** if the caption "Screen recreated from the PrivacyBuddy web app · sample data" stays on screen. The reply text is then an illustration, not model output.

## Open decisions

1. ~~Change the page's "Try an example" to this bank message?~~ Decided: yes, done locally.
2. Recreated screens or a real screen recording on MainNet?
3. Closing line: "Reply to your bank, not to the whole internet", or one from the swap list?
