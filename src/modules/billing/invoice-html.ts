import type { InvoiceRow } from "./invoices.service";

// Standalone, printable tax invoice (browser Print → Save as PDF). Laid out to
// carry the particulars of a GST tax invoice (CGST Rules, rule 46) — have your
// CA confirm before relying on it.

const esc = (value: string | number | null | undefined): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const inr = (paise: number): string =>
  `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const pct = (bp: number): string => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 2)}%`;

function formatIssuedAt(date: Date): string {
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}

export function renderInvoiceHtml(inv: InvoiceRow): string {
  const intraState = inv.igst_paise === 0 && (inv.cgst_paise > 0 || inv.sgst_paise > 0);
  const half = inv.gst_rate_bp / 2;
  const taxRows = intraState
    ? `<tr><td>CGST @ ${pct(half)}</td><td class="num">${inr(inv.cgst_paise)}</td></tr>
       <tr><td>SGST @ ${pct(half)}</td><td class="num">${inr(inv.sgst_paise)}</td></tr>`
    : `<tr><td>IGST @ ${pct(inv.gst_rate_bp)}</td><td class="num">${inr(inv.igst_paise)}</td></tr>`;

  const party = (label: string, p: InvoiceRow["seller"] | InvoiceRow["buyer"]) => `
    <div class="party">
      <div class="label">${esc(label)}</div>
      <div class="name">${esc(p.legalName)}</div>
      ${p.address ? `<div>${esc(p.address).replace(/\n/g, "<br>")}</div>` : ""}
      ${p.stateName ? `<div>State: ${esc(p.stateName)} (${esc(p.stateCode)})</div>` : ""}
      ${p.gstin ? `<div>GSTIN: <strong>${esc(p.gstin)}</strong></div>` : `<div>Unregistered</div>`}
    </div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tax invoice ${esc(inv.invoice_number)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f4f5f4; color: #1b201f; font: 14px/1.5 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
  .sheet { max-width: 800px; margin: 24px auto; background: #fff; padding: 40px; border: 1px solid #dde2df; border-radius: 8px; }
  h1 { margin: 0; font-size: 22px; letter-spacing: -0.01em; }
  .meta { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 28px; }
  .meta .right { text-align: right; color: #4b544f; }
  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 24px; }
  .party .label { font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #4b544f; margin-bottom: 4px; }
  .party .name { font-weight: 700; font-size: 15px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 9px 10px; border-bottom: 1px solid #e6e9e7; text-align: left; vertical-align: top; }
  th { font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: #4b544f; background: #f7f8f6; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .totals { width: 320px; margin: 16px 0 0 auto; }
  .totals td { border-bottom: none; padding: 5px 10px; }
  .totals .grand td { border-top: 2px solid #1b201f; font-weight: 700; font-size: 16px; padding-top: 9px; }
  .notes { margin-top: 28px; font-size: 12px; color: #4b544f; }
  .sign { margin-top: 36px; text-align: right; font-size: 12px; color: #4b544f; }
  .print { text-align: center; margin: 16px; }
  .print button { font: inherit; padding: 8px 16px; border-radius: 8px; border: 1px solid #ea580c; background: #ea580c; color: #fff; cursor: pointer; }
  @media print { body { background: #fff; } .sheet { margin: 0; border: none; border-radius: 0; padding: 0; } .print { display: none; } }
  @media (max-width: 640px) { .sheet { padding: 20px; margin: 0; border-radius: 0; } .parties { grid-template-columns: 1fr; } .totals { width: 100%; } }
</style>
</head>
<body>
<div class="print"><button onclick="window.print()">Print / Save as PDF</button></div>
<div class="sheet">
  <div class="meta">
    <div><h1>Tax Invoice</h1><div>Original for recipient</div></div>
    <div class="right">
      <div>Invoice no. <strong>${esc(inv.invoice_number)}</strong></div>
      <div>Date: ${esc(formatIssuedAt(inv.issued_at))}</div>
      <div>Place of supply: ${esc(inv.buyer.stateName ?? inv.place_of_supply)} (${esc(inv.place_of_supply)})</div>
    </div>
  </div>

  <div class="parties">
    ${party("Supplier", inv.seller)}
    ${party("Billed to", inv.buyer)}
  </div>

  <table>
    <thead>
      <tr><th>Description</th><th>SAC</th><th class="num">Qty</th><th class="num">Rate (incl. GST)</th><th class="num">Amount</th></tr>
    </thead>
    <tbody>
      <tr>
        <td>${esc(inv.description)}</td>
        <td>${esc(inv.sac_code ?? "—")}</td>
        <td class="num">${esc(inv.quantity)}</td>
        <td class="num">${inr(inv.unit_amount_paise)}</td>
        <td class="num">${inr(inv.total_paise)}</td>
      </tr>
    </tbody>
  </table>

  <table class="totals">
    <tr><td>Taxable value</td><td class="num">${inr(inv.taxable_paise)}</td></tr>
    ${taxRows}
    <tr class="grand"><td>Total</td><td class="num">${inr(inv.total_paise)}</td></tr>
  </table>

  <div class="notes">
    Amounts include GST at ${pct(inv.gst_rate_bp)}. Tax is not payable on reverse charge basis.<br>
    Paid online via Razorpay. This is a computer-generated invoice.
  </div>
  <div class="sign">For ${esc(inv.seller.legalName)}<br><br>Authorised signatory</div>
</div>
</body>
</html>`;
}
