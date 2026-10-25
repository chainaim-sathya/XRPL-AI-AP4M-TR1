/**
 * Synthetic, related CSV folders for the Private CFO AI demo (Agentic Finance). Fictional people and companies only;
 * the same --seed always writes the same files. Every file stays at or under --max-rows rows.
 *
 *   node scripts/make-finance-fixtures.ts --kind smb|personal --out <folder> [--seed 7] [--max-rows 1000]
 *                                         [--start 2025-11-01] [--months 12] [--ar-ap csv|erpnext] [--contracts on|off]
 *
 *   --ar-ap erpnext   smb: receivables and payables as ERPNext REST exports instead of invoices.csv / bills.csv:
 *                     erpnext_sales_invoices.json and erpnext_purchase_invoices.json, {"data": [...]} with ERPNext's
 *                     Sales/Purchase Invoice fieldnames (name, customer|supplier, customer_name|supplier_name,
 *                     posting_date, due_date, grand_total, outstanding_amount, status, currency, po_no|bill_no)
 *   --contracts on    smb: also writes contracts/*.md, three fixed-rate financing documents (default on):
 *                     an equipment term loan already being repaid (its monthly payments are in bank.csv), an invoice
 *                     finance advance drawn in the period (bullet, in bank.csv), and a proposed 90-day working-capital
 *                     loan for the open order (not drawn yet)
 *
 * smb  — "Jupiter Knits (demo)", a knitwear maker:
 *   customers.csv      Customer ID, Customer Name, Country, Payment Terms Days, Credit Limit
 *   sales_orders.csv   SO No, Order Date, Customer ID, SKU, Qty, Unit Price, Amount, Ship Date, Status
 *   invoices.csv       Invoice No, SO No, Customer ID, Invoice Date, Due Date, Amount, Status   (receivables)
 *   receipts.csv       Receipt No, Invoice No, Customer ID, Received Date, Amount, Method
 *   suppliers.csv      Supplier ID, Supplier Name, Category, Payment Terms Days
 *   bills.csv          Bill No, Supplier ID, Bill Date, Due Date, Amount, Category, Status      (payables)
 *   inventory.csv      SKU, Description, Category, On Hand, Unit Cost, Unit Price, Reorder Point, Last Sold Date
 *   bank.csv           Date, Description, Reference, Debit, Credit, Balance  (Reference = Receipt No / Bill No / ...)
 *   Planted: the biggest customer (Northline Apparel) starts paying ~30 days late from month 8; cash dips after it;
 *   one large open order from Northline ships after the period (the reason for a 90-day working-capital loan);
 *   a few slow-moving SKUs.
 *
 * personal — "Alex Rivera (demo)":
 *   bank_statement.csv     Date, Txn ID, Description, Merchant, Category, Debit, Credit, Balance
 *   credit_card.csv        Date, Card Txn ID, Merchant, Category, Amount, Statement ID
 *   card_statements.csv    Statement ID, Period End, Due Date, Statement Balance, Paid Txn ID
 *   bills.csv              Bill ID, Payee, Category, Due Date, Amount, Paid Txn ID, Paid Date
 *   budget.csv             Category, Monthly Budget
 *   Planted: dining over budget in 3 months; one bill paid late; a subscription that starts mid-year.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: f } = parseArgs({ strict: true, options: {
  kind: { type: "string" }, out: { type: "string" }, seed: { type: "string", default: "7" },
  "max-rows": { type: "string", default: "1000" }, start: { type: "string", default: "2025-11-01" }, months: { type: "string", default: "12" },
  "ar-ap": { type: "string", default: "csv" }, contracts: { type: "string", default: "on" },
} });
const fail = (m: string): never => { console.error(`make-finance-fixtures: ${m}`); process.exit(2); };
if (f.kind !== "smb" && f.kind !== "personal") fail("--kind must be smb or personal");
if (!f.out) fail("--out <folder> is required");
const maxRows = Number(f["max-rows"]), months = Number(f.months);
if (!Number.isInteger(maxRows) || maxRows < 50) fail("--max-rows must be a whole number >= 50");
if (!Number.isInteger(months) || months < 3 || months > 24) fail("--months must be 3 to 24");
if (!/^\d{4}-\d{2}-01$/.test(f.start!)) fail("--start must be the first of a month, YYYY-MM-01");
if (f["ar-ap"] !== "csv" && f["ar-ap"] !== "erpnext") fail("--ar-ap must be csv or erpnext");
if (f.contracts !== "on" && f.contracts !== "off") fail("--contracts must be on or off");

// ---- helpers ------------------------------------------------------------------------------------------------
let s = Number(f.seed) >>> 0 || 7;
const rnd = (): number => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const between = (a: number, b: number): number => a + rnd() * (b - a);
const int = (a: number, b: number): number => Math.floor(between(a, b + 1));
const money = (n: number): string => n.toFixed(2);
const DAY = 86400000;
const t0 = Date.parse(f.start! + "T00:00:00Z");
const tEnd = Date.UTC(new Date(t0).getUTCFullYear(), new Date(t0).getUTCMonth() + months, 1) - DAY; // last day of the period
const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);
const addDays = (t: number, d: number): number => t + Math.round(d) * DAY;
const monthStart = (i: number): number => Date.UTC(new Date(t0).getUTCFullYear(), new Date(t0).getUTCMonth() + i, 1);
const csvCell = (v: unknown): string => { const x = String(v ?? ""); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
const written: string[] = [];
function write(name: string, header: string[], rows: unknown[][]): void {
  if (rows.length > maxRows) rows = rows.slice(0, maxRows);
  writeFileSync(join(f.out!, name), [header.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n") + "\n");
  written.push(`${name} ${rows.length}`);
}
function writeJson(name: string, records: Record<string, unknown>[]): void {
  if (records.length > maxRows) records = records.slice(0, maxRows);
  writeFileSync(join(f.out!, name), JSON.stringify({ data: records }, null, 1) + "\n"); // the shape of ERPNext's GET /api/resource/<doctype>
  written.push(`${name} ${records.length}`);
}
const longDate = (d: string): string => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
function writeContracts(tl: { notional: number; rate: number; months: number; start: string }, annuity: number, ifDraw: string): void {
  const dir = join(f.out!, "contracts");
  mkdirSync(dir, { recursive: true });
  const ifMat = (() => { const d = new Date(ifDraw + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 91); return iso(d.getTime()); })();
  const wcDraw = (() => { const d = new Date(tEnd + DAY); d.setUTCDate(2); return iso(d.getTime()); })();
  const docs: [string, string][] = [
    ["equipment_term_loan_harbor.md", `# Equipment Term Loan Agreement (demo, fictional parties)

**Lender:** Harbor Equipment Finance (demo)
**Borrower:** Jupiter Knits (demo)
**Purpose:** purchase of two computerised flat-knitting machines.

1. **Facility.** The Lender makes available to the Borrower a term loan of USD ${tl.notional.toLocaleString("en-US")} (${"one hundred and twenty thousand"} United States dollars) (the "Loan").
2. **Drawdown.** The Loan was drawn in full on ${longDate(tl.start)} (the "Drawdown Date").
3. **Interest.** Interest accrues at a fixed rate of ${(tl.rate * 100).toFixed(2)}% per annum for the life of the Loan, calculated on a 30/360 basis.
4. **Repayment.** The Borrower shall repay the Loan in ${tl.months} equal consecutive monthly instalments of principal and interest, the first falling one month after the Drawdown Date and the last on the maturity date. Each instalment is USD ${annuity.toLocaleString("en-US", { minimumFractionDigits: 2 })}.
5. **Prepayment.** Voluntary prepayment is permitted on any instalment date with 30 days' notice, without penalty.
6. **Security.** The machines are pledged to the Lender until the Loan is repaid in full.
`],
    ["invoice_finance_advance_kestrel.md", `# Invoice Finance Advance — Confirmation (demo, fictional parties)

**Financier:** Kestrel Trade Finance (demo)
**Client:** Jupiter Knits (demo)

We confirm an advance of USD 30,000 against receivables due from Northline Apparel (demo), paid to the Client on ${longDate(ifDraw)}.
The advance bears interest at a fixed rate of 10.00% per annum (actual/365) and is repayable in a single payment of principal together with all accrued interest on ${longDate(ifMat)}, ninety-one days after the advance date.
No instalments are due before that date.
`],
    ["working_capital_loan_proposal_kestrel.md", `# Term Sheet — Purchase-Order Working-Capital Loan (PROPOSAL, not signed; demo, fictional parties)

**Lender:** Kestrel Trade Finance (demo)
**Borrower:** Jupiter Knits (demo)
**Purpose:** yarn purchases and wages for the open Northline Apparel (demo) order.

- **Amount:** USD 50,000
- **Interest:** 12% per annum, fixed for the whole term (30/360)
- **Term:** 3 months from drawdown
- **Expected drawdown:** ${longDate(wcDraw)}
- **Repayment:** three equal monthly instalments of principal and interest, the first one month after drawdown
- **Settlement:** in RLUSD on the XRP Ledger, under the XRPL Lending Protocol (fixed rate, fixed term)
- **Conditions:** monthly reporting of receivables ageing and cash position to the Lender
`],
  ];
  for (const [name, text] of docs) writeFileSync(join(dir, name), text);
  written.push(`contracts/ ${docs.length}`);
}
mkdirSync(f.out!, { recursive: true });

if (f.kind === "smb") {
  // ---- customers, suppliers, products --------------------------------------------------------------------
  const customers = [
    ["C001", "Northline Apparel (demo)", "US", 60, 400000, 0.30], ["C002", "Bluefjord Outfitters (demo)", "NO", 45, 150000, 0.12],
    ["C003", "Maple & Moss Retail (demo)", "CA", 30, 90000, 0.10], ["C004", "Sakura Knit House (demo)", "JP", 45, 120000, 0.10],
    ["C005", "Riverbend Boutiques (demo)", "US", 30, 60000, 0.08], ["C006", "Alpine Thread Co (demo)", "CH", 30, 80000, 0.08],
    ["C007", "Coastal Wool Shop (demo)", "AU", 45, 50000, 0.07], ["C008", "Highland Goods (demo)", "UK", 30, 70000, 0.07],
    ["C009", "Urban Loom Stores (demo)", "DE", 30, 40000, 0.05], ["C010", "Prairie Supply (demo)", "US", 30, 30000, 0.03],
  ] as const;
  const suppliers = [
    ["S001", "Kaveri Yarn Mills (demo)", "Yarn", 30], ["S002", "Tiruppur Spinners (demo)", "Yarn", 45], ["S003", "Colourline Dyes (demo)", "Dyes", 30],
    ["S004", "BoxRight Packaging (demo)", "Packaging", 30], ["S005", "SeaRoute Logistics (demo)", "Logistics", 15], ["S006", "Grid Power Co (demo)", "Utilities", 15],
    ["S007", "Needlework Machines (demo)", "Maintenance", 30], ["S008", "Label & Tag Works (demo)", "Packaging", 30],
  ] as const;
  const kinds = [["Sweater", "Sweaters", 18, 42], ["Cardigan", "Cardigans", 20, 48], ["Scarf", "Scarves", 6, 16], ["Beanie", "Accessories", 4, 11], ["Polo knit", "Knit tops", 9, 22]] as const;
  const fibres = ["Merino", "Cotton", "Lambswool", "Cashmere blend", "Recycled wool", "Organic cotton"];
  const products = Array.from({ length: 60 }, (_, i) => {
    const [noun, cat, lo, hi] = kinds[i % kinds.length];
    const cost = between(lo, hi);
    return { sku: `JK-${String(1001 + i)}`, desc: `${fibres[i % fibres.length]} ${noun.toLowerCase()}`, cat, cost, price: cost * between(1.7, 2.3), slow: i % 17 === 5 };
  });
  // ---- sales orders, invoices, receipts ---------------------------------------------------------------
  const weights = customers.map((c) => c[5]);
  const wpick = () => { let r = rnd() * weights.reduce((a, b) => a + b, 0); for (let i = 0; i < customers.length; i++) { r -= weights[i]; if (r <= 0) return customers[i]; } return customers[0]; };
  const so: unknown[][] = [], inv: unknown[][] = [], rct: unknown[][] = [], bank: { t: number; desc: string; ref: string; dr: number; cr: number }[] = [];
  let soN = 10001, invN = 20001, rctN = 30001;
  const nSO = Math.min(maxRows - 10, 380);
  for (let k = 0; k < nSO; k++) {
    const c = wpick();
    const p = products.filter((x) => !x.slow || rnd() < 0.15)[int(0, 59 - 3)] ?? products[0];
    const tOrder = addDays(t0, -75 + rnd() * ((tEnd - t0) / DAY + 75 - 20)); // orders from 75 days before the period, so receipts are steady from month 1
    const qty = c[0] === "C001" ? int(180, 650) : int(18, 170);
    const amount = qty * p.price;
    const tShip = addDays(tOrder, int(10, 25));
    const soNo = `SO-${soN++}`;
    so.push([soNo, iso(tOrder), c[0], p.sku, qty, money(p.price), money(amount), tShip <= tEnd ? iso(tShip) : "", tShip <= tEnd ? "Shipped" : "Open"]);
    if (tShip > tEnd) continue;
    const invNo = `INV-${invN++}`, tDue = addDays(tShip, c[3]);
    // Northline pays ~30 days late from month 8 on; others mostly on time.
    const month = new Date(tShip).getUTCMonth() - new Date(t0).getUTCMonth() + 12 * (new Date(tShip).getUTCFullYear() - new Date(t0).getUTCFullYear());
    const late = c[0] === "C001" && month >= 7 ? between(20, 40) : rnd() < 0.12 ? between(5, 20) : between(-5, 3);
    const tPaid = addDays(tDue, late);
    const paid = tPaid <= tEnd;
    inv.push([invNo, soNo, c[0], iso(tShip), iso(tDue), money(amount), paid ? "Paid" : tEnd > tDue ? "Overdue" : "Open"]);
    if (paid) {
      const rNo = `RCT-${rctN++}`;
      rct.push([rNo, invNo, c[0], iso(tPaid), money(amount), pick(["Wire", "Wire", "ACH", "Letter of credit"])]);
      bank.push({ t: tPaid, desc: `Customer payment ${c[1]}`, ref: rNo, dr: 0, cr: amount });
    }
  }
  // The large open order that needs working capital (ships after the period).
  so.push([`SO-${soN++}`, iso(addDays(tEnd, -10)), "C001", products[0].sku, 6000, money(products[0].price), money(6000 * products[0].price), "", "Open"]);
  // ---- bills (payables) and other bank movements --------------------------------------------------
  const bills: unknown[][] = [];
  let billN = 40001;
  for (let m = 0; m < months; m++) {
    for (let k = 0; k < 18; k++) {
      const sp = k < 8 ? suppliers[k % 2] : pick(suppliers);
      const tBill = addDays(monthStart(m), int(0, 27));
      const amount = sp[2] === "Yarn" ? between(6000, 22000) : sp[2] === "Utilities" ? between(1800, 3200) : between(400, 4500);
      const tDue = addDays(tBill, sp[3]), tPay = addDays(tDue, rnd() < 0.1 ? int(3, 15) : int(-3, 0));
      const bNo = `BILL-${billN++}`;
      bills.push([bNo, sp[0], iso(tBill), iso(tDue), money(amount), sp[2], tPay <= tEnd ? "Paid" : "Open"]);
      if (tPay <= tEnd) bank.push({ t: tPay, desc: `Supplier payment ${sp[1]}`, ref: bNo, dr: amount, cr: 0 });
    }
    const ym = iso(monthStart(m)).slice(0, 7);
    bank.push({ t: addDays(monthStart(m), 27), desc: "Payroll", ref: `PAYROLL-${ym}`, dr: between(52000, 56000), cr: 0 });
    bank.push({ t: addDays(monthStart(m), 0), desc: "Factory rent", ref: `RENT-${ym}`, dr: 9500, cr: 0 });
  }
  // Financing (also described in contracts/*.md): an equipment term loan being repaid monthly, and an invoice-finance advance.
  const tl = { notional: 120000, rate: 0.095, months: 36, start: "2025-06-15" };
  const r = tl.rate / 12, annuity = Math.round((tl.notional * r / (1 - Math.pow(1 + r, -tl.months))) * 100) / 100;
  for (let k = 1; k <= tl.months; k++) {
    const d = new Date(tl.start + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + k);
    if (d.getTime() >= t0 && d.getTime() <= tEnd) bank.push({ t: d.getTime(), desc: "Loan repayment Harbor Equipment Finance (demo)", ref: `HARBOR-TL-${iso(d.getTime()).slice(0, 7)}`, dr: annuity, cr: 0 });
  }
  const ifDraw = Date.UTC(new Date(t0).getUTCFullYear(), new Date(t0).getUTCMonth() + months - 2, 15);
  bank.push({ t: ifDraw, desc: "Invoice finance advance Kestrel Trade Finance (demo)", ref: "KESTREL-IF-30K", dr: 0, cr: 30000 });
  bank.sort((a, b) => a.t - b.t);
  let bal = 200000;
  const bankRows = bank.filter((b) => b.t >= t0).map((b) => { bal += b.cr - b.dr; return [iso(b.t), b.desc, b.ref, b.dr ? money(b.dr) : "", b.cr ? money(b.cr) : "", money(bal)]; });
  // ---- inventory --------------------------------------------------------------------------------------
  const lastSold = new Map<string, string>();
  for (const r of so) if (r[8] === "Shipped") { const d = String(r[7]); if ((lastSold.get(String(r[3])) ?? "") < d) lastSold.set(String(r[3]), d); }
  const invRows = products.map((p) => [p.sku, p.desc, p.cat, p.slow ? int(900, 2500) : int(60, 800), money(p.cost), money(p.price), int(100, 300), lastSold.get(p.sku) ?? ""]);
  write("customers.csv", ["Customer ID", "Customer Name", "Country", "Payment Terms Days", "Credit Limit"], customers.map((c) => [c[0], c[1], c[2], c[3], c[4]]));
  write("suppliers.csv", ["Supplier ID", "Supplier Name", "Category", "Payment Terms Days"], suppliers.map((x) => [...x]));
  write("sales_orders.csv", ["SO No", "Order Date", "Customer ID", "SKU", "Qty", "Unit Price", "Amount", "Ship Date", "Status"], so);
  const custName = new Map<string, string>(customers.map((c) => [c[0], c[1]])), supName = new Map<string, string>(suppliers.map((x) => [x[0], x[1]]));
  if (f["ar-ap"] === "csv") write("invoices.csv", ["Invoice No", "SO No", "Customer ID", "Invoice Date", "Due Date", "Amount", "Status"], inv);
  else writeJson("erpnext_sales_invoices.json", inv.map((x) => ({ name: x[0], customer: x[2], customer_name: custName.get(String(x[2])), posting_date: x[3], due_date: x[4],
    grand_total: Number(x[5]), outstanding_amount: x[6] === "Paid" ? 0 : Number(x[5]), status: x[6] === "Open" ? "Unpaid" : x[6], currency: "USD", po_no: x[1] })));
  write("receipts.csv", ["Receipt No", "Invoice No", "Customer ID", "Received Date", "Amount", "Method"], rct);
  if (f["ar-ap"] === "csv") write("bills.csv", ["Bill No", "Supplier ID", "Bill Date", "Due Date", "Amount", "Category", "Status"], bills);
  else writeJson("erpnext_purchase_invoices.json", bills.map((x) => ({ name: x[0], supplier: x[1], supplier_name: supName.get(String(x[1])), posting_date: x[2], due_date: x[3],
    bill_no: x[0], grand_total: Number(x[4]), outstanding_amount: x[6] === "Paid" ? 0 : Number(x[4]), status: x[6] === "Open" ? "Unpaid" : x[6], currency: "USD", expense_category: x[5] })));
  if (f.contracts === "on") writeContracts(tl, annuity, iso(ifDraw));
  write("inventory.csv", ["SKU", "Description", "Category", "On Hand", "Unit Cost", "Unit Price", "Reorder Point", "Last Sold Date"], invRows);
  write("bank.csv", ["Date", "Description", "Reference", "Debit", "Credit", "Balance"], bankRows);
} else {
  // ---- personal ---------------------------------------------------------------------------------------
  const budget: [string, number][] = [["Rent", 2100], ["Groceries", 650], ["Dining", 300], ["Transport", 220], ["Utilities", 180], ["Shopping", 350], ["Subscriptions", 45], ["Health", 120], ["Travel", 250], ["Insurance", 160], ["Phone & Internet", 110], ["Savings transfer", 800]];
  const merchants: Record<string, string[]> = {
    Groceries: ["FreshMart (demo)", "Green Basket (demo)", "City Grocer (demo)"], Dining: ["Luna Cafe (demo)", "Taco Corner (demo)", "Saffron Kitchen (demo)", "Noodle Bar (demo)"],
    Transport: ["MetroCard (demo)", "RideNow (demo)", "Fuel Stop (demo)"], Shopping: ["Bookhaven (demo)", "Gadget Hub (demo)", "Style Lane (demo)"],
    Health: ["Wellness Pharmacy (demo)", "FitLife Gym (demo)"], Travel: ["SkyHop Air (demo)", "Stayeasy Hotels (demo)"], Subscriptions: ["StreamBox (demo)", "CloudDrive (demo)", "NewsDaily (demo)"],
  };
  const bankRows: { t: number; id?: string; desc: string; merch: string; cat: string; dr: number; cr: number }[] = [];
  const card: unknown[][] = [], stmts: unknown[][] = [], bills: unknown[][] = [];
  let cardN = 1, billN = 1;
  for (let m = 0; m < months; m++) {
    const ms = monthStart(m), ym = iso(ms).slice(0, 7);
    bankRows.push({ t: addDays(ms, 0), desc: "Salary", merch: "Orbit Software (demo)", cat: "Income", dr: 0, cr: 6200 });
    bankRows.push({ t: addDays(ms, 2), desc: "Rent", merch: "Parkside Lettings (demo)", cat: "Rent", dr: 2100, cr: 0 });
    bankRows.push({ t: addDays(ms, 5), desc: "Transfer to savings", merch: "Own savings", cat: "Savings transfer", dr: 800, cr: 0 });
    for (let k = 0; k < 14; k++) { const cat = pick(["Groceries", "Groceries", "Transport", "Health"]); bankRows.push({ t: addDays(ms, int(0, 27)), desc: "Debit card", merch: pick(merchants[cat]), cat, dr: cat === "Groceries" ? between(25, 120) : between(8, 60), cr: 0 }); }
    // Card spending; dining runs over budget in months 3, 6 and 10; a subscription starts in month 6.
    const stmtId = `STMT-${ym}`;
    let stmtTotal = 0;
    for (let k = 0; k < 26; k++) {
      const cat = pick(["Dining", "Dining", "Shopping", "Transport", "Groceries", "Travel", "Subscriptions"]);
      if (cat === "Subscriptions" && m < 5 && rnd() < 0.5) continue;
      const over = cat === "Dining" && [2, 5, 9].includes(m) ? 2.2 : 1;
      const amt = (cat === "Travel" ? between(60, 420) : cat === "Subscriptions" ? pick([9.99, 12.99, 15.99]) : between(12, 70)) * over;
      stmtTotal += amt;
      card.push([iso(addDays(ms, int(0, 27))), `CTX-${String(cardN++).padStart(5, "0")}`, pick(merchants[cat]), cat, money(amt), stmtId]);
    }
    const tDue = addDays(ms, 45);
    bankRows.push({ t: tDue <= tEnd ? addDays(tDue, -2) : tEnd, id: `PAY-${stmtId}`, desc: "Credit card payment", merch: "Card issuer", cat: "Card payment", dr: stmtTotal, cr: 0 });
    stmts.push([stmtId, iso(addDays(monthStart(m + 1), -1)), iso(tDue), money(stmtTotal), `PAY-${stmtId}`]);
    // Bills paid from the bank; one is late (month 4, utilities).
    for (const [payee, cat, amt] of [["Citywide Power (demo)", "Utilities", between(90, 170)], ["FiberNet (demo)", "Phone & Internet", 109.99], ["SafeHome Insurance (demo)", "Insurance", 158]] as const) {
      const due = addDays(ms, 20), paidT = cat === "Utilities" && m === 3 ? addDays(due, 12) : addDays(due, -int(0, 3));
      const bId = `BILL-${String(billN++).padStart(4, "0")}`, txn = `PAY-${bId}`;
      bills.push([bId, payee, cat, iso(due), money(amt), txn, iso(paidT)]);
      bankRows.push({ t: paidT, id: txn, desc: `Bill payment ${payee}`, merch: payee, cat, dr: amt, cr: 0 });
    }
  }
  bankRows.sort((a, b) => a.t - b.t);
  let bal = 4200, n = 1;
  const rows = bankRows.filter((b) => b.t <= tEnd).map((b) => { bal += b.cr - b.dr; return [iso(b.t), b.id ?? `TXN-${String(n++).padStart(6, "0")}`, b.desc, b.merch, b.cat, b.dr ? money(b.dr) : "", b.cr ? money(b.cr) : "", money(bal)]; });
  write("bank_statement.csv", ["Date", "Txn ID", "Description", "Merchant", "Category", "Debit", "Credit", "Balance"], rows);
  write("credit_card.csv", ["Date", "Card Txn ID", "Merchant", "Category", "Amount", "Statement ID"], card);
  write("card_statements.csv", ["Statement ID", "Period End", "Due Date", "Statement Balance", "Paid Txn ID"], stmts);
  write("bills.csv", ["Bill ID", "Payee", "Category", "Due Date", "Amount", "Paid Txn ID", "Paid Date"], bills);
  write("budget.csv", ["Category", "Monthly Budget"], budget.map(([c, b]) => [c, money(b)]));
}
console.log(`wrote ${f.out} (${f.kind}): ${written.join(", ")}`);
