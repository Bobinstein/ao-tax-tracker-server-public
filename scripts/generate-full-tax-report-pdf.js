#!/usr/bin/env node
/**
 * Generate full tax report PDF via local API.
 * Requires server running on port 3000 and ADMIN_AUTH_BYPASS_CODE in .env.
 *
 * Usage: node scripts/generate-full-tax-report-pdf.js [wallet] [year] [currency]
 * Defaults: wallet (see below), year = current year - 1 (prior tax year), currency USD.
 *
 * Supported currencies (for reference; report uses fiat conversion when not USD):
 *   USD, EUR, GBP, JPY, AUD, CAD, CHF, CNY, INR, KRW, BRL, MXN, SGD, HKD, NZD, SEK, NOK, DKK
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const fs = require("fs");

const wallet = process.argv[2] || "SBB-pCi_TZatV-ucWo_FVYZX_fsXwPms5WXZIKxsiuc";
const taxYear = parseInt(
  process.argv[3] || String(new Date().getFullYear() - 1),
  10,
);
const currency = (process.argv[4] || "USD").toUpperCase();
const baseUrl = process.env.API_BASE_URL || "http://localhost:3000";
const bypass = process.env.ADMIN_AUTH_BYPASS_CODE;

if (!bypass) {
  console.error("ADMIN_AUTH_BYPASS_CODE not set in .env");
  process.exit(1);
}

const outDir = path.join(__dirname, "..", "reports");
const outPath = path.join(
  outDir,
  currency === "USD"
    ? "full-tax-report.pdf"
    : `full-tax-report-${currency}.pdf`,
);

async function main() {
  console.log(
    `Requesting full tax report PDF for ${wallet} ${taxYear} (${currency})...`,
  );
  const res = await fetch(`${baseUrl}/api/wallet-report/pdf`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Bypass": bypass,
    },
    body: JSON.stringify({ wallet, taxYear, currency }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error("Request failed:", res.status, text);
    process.exit(1);
  }
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, buf);
  console.log(`Wrote ${buf.length} bytes to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
