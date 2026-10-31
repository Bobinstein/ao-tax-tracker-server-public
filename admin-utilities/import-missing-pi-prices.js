#!/usr/bin/env node

/**
 * Admin Utility: Import Missing PI Prices
 *
 * This script manually imports PI prices for dates when the pool didn't exist yet.
 * Based on the PI price fetcher, it uses the same keyspace and table structure.
 *
 * Usage: node admin-utilities/import-missing-pi-prices.js
 */

const cassandra = require("cassandra-driver");
const CONFIG = require("../config/database");

async function importMissingPIPrices() {
  console.log("📊 Importing missing PI prices for early August 2025...");
  console.log(
    "⚠️  These are manual prices for dates when the pool didn't exist yet"
  );

  const client = new cassandra.Client(CONFIG.PRICE_DB);
  await client.connect();

  try {
    // Check if prices already exist
    console.log("🔍 Checking for existing PI prices...");
    const checkQuery = `
      SELECT date, token_symbol, price_usd 
      FROM daily_prices 
      WHERE token_symbol = 'PI' 
      AND date IN ('2025-08-01', '2025-08-02', '2025-08-03', '2025-08-04')
      ALLOW FILTERING
    `;

    const existingResult = await client.execute(checkQuery);

    if (existingResult.rows.length > 0) {
      console.log("⚠️  Found existing PI prices for some dates:");
      existingResult.rows.forEach((row) => {
        console.log(`   ${row.date}: $${row.price_usd}`);
      });

      const overwrite = process.argv.includes("--overwrite");
      if (!overwrite) {
        console.log("💡 Use --overwrite flag to replace existing prices");
        console.log("❌ Aborting to prevent overwriting existing data");
        return;
      } else {
        console.log(
          "🔄 --overwrite flag detected, will replace existing prices"
        );
      }
    }

    // Manual PI prices for early August 2025
    const missingPrices = [
      { date: "2025-08-01", price: 6.551 },
      { date: "2025-08-02", price: 1.977 },
      { date: "2025-08-03", price: 1.822 },
      { date: "2025-08-04", price: 1.778 },
    ];

    console.log("\n📝 Importing PI prices:");

    for (const priceData of missingPrices) {
      const { date, price } = priceData;
      const timestamp = Math.floor(Date.now() / 1000);
      const now = new Date();

      // Delete existing price if overwriting
      if (process.argv.includes("--overwrite")) {
        const deleteQuery = `
          DELETE FROM daily_prices 
          WHERE date = ? AND token_symbol = ?
        `;
        await client.execute(deleteQuery, [date, "PI"]);
        console.log(`   🗑️  Cleared existing price for ${date}`);
      }

      // Insert new price
      const insertQuery = `
        INSERT INTO daily_prices (
          date, token_symbol, data_source, timestamp, price_usd,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `;

      const values = [
        date,
        "PI",
        "manual-import", // Special data source to indicate manual import
        timestamp,
        price.toString(), // Store as string to avoid BigDecimal issues
        now,
        now,
      ];

      await client.execute(insertQuery, values);
      console.log(`   ✅ ${date}: $${price} (manual-import)`);
    }

    console.log("\n📊 Verification - checking imported prices:");
    const verifyQuery = `
      SELECT date, token_symbol, price_usd, data_source 
      FROM daily_prices 
      WHERE token_symbol = 'PI' 
      AND date IN ('2025-08-01', '2025-08-02', '2025-08-03', '2025-08-04')
      ALLOW FILTERING
    `;

    const verifyResult = await client.execute(verifyQuery);

    if (verifyResult.rows.length > 0) {
      console.log("✅ Successfully imported PI prices:");
      // Sort results by date in JavaScript since ORDER BY with ALLOW FILTERING is not allowed
      const sortedRows = verifyResult.rows.sort((a, b) =>
        a.date.localeCompare(b.date)
      );
      sortedRows.forEach((row) => {
        console.log(`   ${row.date}: $${row.price_usd} (${row.data_source})`);
      });
    } else {
      console.log("❌ No prices found after import - something went wrong");
    }

    console.log("\n✅ Missing PI prices import completed");
    console.log("💡 These prices will now be available for PDF generation");
  } catch (error) {
    console.error("❌ Error importing PI prices:", error.message);
    process.exit(1);
  } finally {
    await client.shutdown();
    console.log("✅ Cassandra connection closed");
  }
}

// Check command line arguments
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "Usage: node admin-utilities/import-missing-pi-prices.js [--overwrite]"
  );
  console.log("");
  console.log("Options:");
  console.log("  --overwrite    Replace existing prices if they exist");
  console.log("  --help, -h     Show this help message");
  console.log("");
  console.log(
    "This script imports PI prices for 2025-08-01 through 2025-08-04"
  );
  console.log("when the pool didn't exist yet, using manual price data.");
  process.exit(0);
}

importMissingPIPrices();
