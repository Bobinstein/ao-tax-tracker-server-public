#!/usr/bin/env node
/**
 * Generate distribution report PDF via local API.
 * Requires server running on port 3000 and ADMIN_AUTH_BYPASS_CODE in .env.
 *
 * Usage: node scripts/generate-distribution-report-pdf.js [wallet] [year] [currency] [--include-staked]
 * Defaults: wallet (see below), year 2025, currency USD.
 *
 * Examples:
 *   node scripts/generate-distribution-report-pdf.js
 *   node scripts/generate-distribution-report-pdf.js cF0H... 2025
 *   node scripts/generate-distribution-report-pdf.js cF0H... 2025 INR
 *   node scripts/generate-distribution-report-pdf.js cF0H... 2025 EUR --include-staked
 *
 * Supported currencies (for reference; distribution report may use USD until backend supports currency):
 *   USD, EUR, GBP, JPY, AUD, CAD, CHF, CNY, INR, KRW, BRL, MXN, SGD, HKD, NZD, SEK, NOK, DKK
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const fs = require("fs");

const args = process.argv.slice(2);
const includeStaked = args.includes("--include-staked");
const positional = args.filter((a) => a !== "--include-staked");

const wallet = positional[0] || "SBB-pCi_TZatV-ucWo_FVYZX_fsXwPms5WXZIKxsiuc";
const taxYear = parseInt(
  positional[1] || String(new Date().getFullYear() - 1),
  10,
);
const currency = (positional[2] || "USD").toUpperCase();

// Report range is always full calendar year for the requested year
const startDate = `${taxYear}-01-01`;
const endDate = `${taxYear}-12-31`;

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
    ? "distribution-report.pdf"
    : `distribution-report-${currency}.pdf`,
);

async function main() {
  console.log(
    `Requesting distribution report PDF for ${wallet} (${startDate} to ${endDate}) ${currency}${includeStaked ? " [including staked]" : ""}...`,
  );
  const res = await fetch(`${baseUrl}/api/distributions/pdf`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Bypass": bypass,
      "x-year": String(taxYear),
    },
    body: JSON.stringify({
      wallet,
      includeStaked,
      currency,
    }),
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
