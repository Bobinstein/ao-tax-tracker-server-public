#!/usr/bin/env node
/**
 * Add Full Tax Report auths via the admin-protected endpoint.
 * Writes to the subscription cache so isAuthorized allows Full Tax Report for the given wallet(s) and year(s).
 *
 * Requires:
 *   - Server running (local or API_BASE_URL)
 *   - ADMIN_AUTH_BYPASS_CODE in .env (or env)
 *
 * Usage:
 *   node scripts/add-full-tax-auths.js --wallet <addr> --year <year>
 *   node scripts/add-full-tax-auths.js --wallet <addr1> --wallet <addr2> --year 2025 --year 2024
 *   node scripts/add-full-tax-auths.js --wallets "addr1,addr2" --years "2025,2024"
 *
 * Examples:
 *   node scripts/add-full-tax-auths.js --wallet 7waR8v4STuwPnTck1zFVkQqJh5K9q9Zik4Y5-5dV7nk --year 2025
 *   node scripts/add-full-tax-auths.js --wallets "addr1,addr2" --years "2024,2025"
 *   API_BASE_URL=https://your-api.example.com node scripts/add-full-tax-auths.js --wallet addr1 --year 2025
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const args = process.argv.slice(2);

function parseArgs() {
  const wallets = [];
  const years = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--wallet" && args[i + 1]) {
      wallets.push(args[++i].trim());
    } else if (args[i] === "--year" && args[i + 1]) {
      const y = parseInt(args[++i], 10);
      if (!isNaN(y)) years.push(y);
    } else if (args[i] === "--wallets" && args[i + 1]) {
      args[++i].split(",").forEach((w) => {
        const t = w.trim();
        if (t) wallets.push(t);
      });
    } else if (args[i] === "--years" && args[i + 1]) {
      args[++i].split(",").forEach((y) => {
        const n = parseInt(y.trim(), 10);
        if (!isNaN(n)) years.push(n);
      });
    }
  }
  return { wallets, years };
}

const { wallets, years } = parseArgs();

const baseUrl = process.env.API_BASE_URL || "http://localhost:3000";
const bypass = process.env.ADMIN_AUTH_BYPASS_CODE;

if (!bypass) {
  console.error("❌ ADMIN_AUTH_BYPASS_CODE not set. Set it in .env or env.");
  process.exit(1);
}

if (!wallets.length || !years.length) {
  console.error("❌ Provide at least one wallet and one year.");
  console.error(
    "   Example: node scripts/add-full-tax-auths.js --wallet <addr> --year 2025",
  );
  console.error(
    '   Or:      node scripts/add-full-tax-auths.js --wallets "addr1,addr2" --years "2024,2025"',
  );
  process.exit(1);
}

const invalidYears = years.filter((y) => y < 2000 || y > 2100);
if (invalidYears.length) {
  console.error("❌ Years must be 2000–2100. Invalid:", invalidYears);
  process.exit(1);
}

async function main() {
  console.log(
    `Adding Full Tax Report auth for ${wallets.length} wallet(s) × ${years.length} year(s)...`,
  );
  const res = await fetch(`${baseUrl}/api/admin/subscriptions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Bypass": bypass,
    },
    body: JSON.stringify({ wallets, years }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error(
      "❌ Request failed:",
      res.status,
      data.error || data.message || data,
    );
    process.exit(1);
  }

  console.log("✅ Success:", data.message);
  console.log("   Added:", data.added);
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
