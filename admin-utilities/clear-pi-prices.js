#!/usr/bin/env node

/**
 * Admin Utility: Clear PI Price Data
 *
 * This script clears all PI price data from the daily_prices table.
 * Use this when you need to refresh PI price data completely.
 *
 * Usage: node admin-utilities/clear-pi-prices.js
 */

const cassandra = require("cassandra-driver");
const CONFIG = require("../config/database");

async function clearPIPrices() {
  console.log("🗑️  Clearing PI price data...");

  const client = new cassandra.Client(CONFIG.PRICE_DB);
  await client.connect();

  try {
    // Count existing records
    const countQuery =
      "SELECT COUNT(*) as count FROM daily_prices WHERE token_symbol = ? ALLOW FILTERING";
    const countResult = await client.execute(countQuery, ["PI"]);
    const existingCount = countResult.rows[0].count;

    console.log(`📊 Found ${existingCount} existing PI price records`);

    if (existingCount === 0) {
      console.log("✅ No PI price data to clear");
      return;
    }

    // Clear all PI price data
    // Note: We need to get all records first, then delete them individually
    // because Cassandra requires all partition key columns for DELETE
    console.log("🔄 Fetching PI records to delete...");
    const selectQuery =
      "SELECT date, data_source FROM daily_prices WHERE token_symbol = ? ALLOW FILTERING";
    const selectResult = await client.execute(selectQuery, ["PI"]);

    console.log(`🗑️  Deleting ${selectResult.rows.length} PI price records...`);

    // Delete each record individually
    for (const row of selectResult.rows) {
      const deleteQuery =
        "DELETE FROM daily_prices WHERE token_symbol = ? AND date = ? AND data_source = ?";
      await client.execute(deleteQuery, ["PI", row.date, row.data_source]);
    }

    console.log(`✅ Cleared ${existingCount} PI price records`);
    console.log(
      "💡 You can now run the update-prices job to fetch fresh PI data"
    );
  } catch (error) {
    console.error("❌ Error clearing PI prices:", error.message);
    process.exit(1);
  } finally {
    await client.shutdown();
  }
}

clearPIPrices();
