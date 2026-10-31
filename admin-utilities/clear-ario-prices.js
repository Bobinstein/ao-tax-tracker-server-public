#!/usr/bin/env node

/**
 * Admin Utility: Clear ARIO Price Data
 *
 * This script clears all ARIO price data from the daily_prices table.
 * Use this when you need to refresh ARIO price data completely.
 *
 * IMPORTANT: This should be run after fixing the ARIO pool process ID
 * to ensure you get correct data from the right pool.
 *
 * Usage: node admin-utilities/clear-ario-prices.js
 */

const cassandra = require("cassandra-driver");
const CONFIG = require("../config/database");

async function clearARIOPrices() {
  console.log("🗑️  Clearing ARIO price data...");

  const client = new cassandra.Client(CONFIG.PRICE_DB);
  await client.connect();

  try {
    // Count existing records
    const countQuery =
      "SELECT COUNT(*) as count FROM daily_prices WHERE token_symbol = ? ALLOW FILTERING";
    const countResult = await client.execute(countQuery, ["ARIO"]);
    const existingCount = countResult.rows[0].count;

    console.log(`📊 Found ${existingCount} existing ARIO price records`);

    if (existingCount === 0) {
      console.log("✅ No ARIO price data to clear");
      return;
    }

    // Show data sources before clearing
    const sourceQuery =
      "SELECT data_source FROM daily_prices WHERE token_symbol = ? ALLOW FILTERING";
    const sourceResult = await client.execute(sourceQuery, ["ARIO"]);
    const sources = [...new Set(sourceResult.rows.map((r) => r.data_source))];
    console.log(`📋 Data sources: ${sources.join(", ")}`);

    // Clear all ARIO price data
    // Note: We need to get all records first, then delete them individually
    // because Cassandra requires all partition key columns for DELETE
    console.log("🔄 Fetching ARIO records to delete...");
    const selectQuery =
      "SELECT date, data_source FROM daily_prices WHERE token_symbol = ? ALLOW FILTERING";
    const selectResult = await client.execute(selectQuery, ["ARIO"]);

    console.log(
      `🗑️  Deleting ${selectResult.rows.length} ARIO price records...`
    );

    // Delete each record individually
    for (const row of selectResult.rows) {
      const deleteQuery =
        "DELETE FROM daily_prices WHERE token_symbol = ? AND date = ? AND data_source = ?";
      await client.execute(deleteQuery, ["ARIO", row.date, row.data_source]);
    }

    console.log(`✅ Cleared ${existingCount} ARIO price records`);
    console.log(
      "💡 You can now run the update-prices job to fetch fresh ARIO data with the correct pool"
    );
  } catch (error) {
    console.error("❌ Error clearing ARIO prices:", error.message);
    process.exit(1);
  } finally {
    await client.shutdown();
  }
}

clearARIOPrices();
