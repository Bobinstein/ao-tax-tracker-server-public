#!/usr/bin/env node

/**
 * Admin Utility: Clear All Price Data
 *
 * This script clears ALL price data from the daily_prices table.
 * Use this when you need to completely refresh all price data.
 *
 * WARNING: This will delete all price data for AR, AO, ARIO, and PI!
 *
 * Usage: node admin-utilities/clear-all-prices.js
 */

const cassandra = require("cassandra-driver");
const CONFIG = require("../config/database");

async function clearAllPrices() {
  console.log("🗑️  Clearing ALL price data...");
  console.log(
    "⚠️  WARNING: This will delete all price data for AR, AO, ARIO, and PI!"
  );

  const client = new cassandra.Client(CONFIG.PRICE_DB);
  await client.connect();

  try {
    // Count existing records for each token
    const tokens = ["AR", "AO", "ARIO", "PI"];
    const counts = {};

    for (const token of tokens) {
      const countQuery =
        "SELECT COUNT(*) as count FROM daily_prices WHERE token_symbol = ? ALLOW FILTERING";
      const countResult = await client.execute(countQuery, [token]);
      counts[token] = countResult.rows[0].count;
    }

    console.log("\n📊 Existing price records:");
    tokens.forEach((token) => {
      console.log(`  ${token}: ${counts[token]} records`);
    });

    const totalRecords = Object.values(counts).reduce(
      (sum, count) => sum + count,
      0
    );

    if (totalRecords === 0) {
      console.log("✅ No price data to clear");
      return;
    }

    // Clear all price data
    console.log("\n🗑️  Clearing all price data...");

    // Get all records first, then delete them individually
    // because we need to handle the partition key properly
    const selectQuery =
      "SELECT token_symbol, date, data_source FROM daily_prices ALLOW FILTERING";
    const selectResult = await client.execute(selectQuery);

    console.log(
      `🔄 Found ${selectResult.rows.length} total records to delete...`
    );

    // Delete each record individually
    for (const row of selectResult.rows) {
      const deleteQuery =
        "DELETE FROM daily_prices WHERE token_symbol = ? AND date = ? AND data_source = ?";
      await client.execute(deleteQuery, [
        row.token_symbol,
        row.date,
        row.data_source,
      ]);
    }

    console.log(`✅ Cleared ${totalRecords} total price records`);
    console.log(
      "💡 You can now run the update-prices job to fetch fresh data for all tokens"
    );
  } catch (error) {
    console.error("❌ Error clearing all prices:", error.message);
    process.exit(1);
  } finally {
    await client.shutdown();
  }
}

clearAllPrices();
