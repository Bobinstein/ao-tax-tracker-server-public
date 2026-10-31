#!/usr/bin/env node

/**
 * Admin Utility: Clear AO Price Data
 *
 * This script clears all AO price data from the daily_prices table.
 * Use this when you need to refresh AO price data completely.
 *
 * Usage: node admin-utilities/clear-ao-prices.js
 */

const cassandra = require("cassandra-driver");
const CONFIG = require("../config/database");

async function clearAOPrices() {
  console.log("🗑️  Clearing AO price data...");

  const client = new cassandra.Client(CONFIG.PRICE_DB);
  await client.connect();

  try {
    // Count existing records
    const countQuery =
      "SELECT COUNT(*) as count FROM daily_prices WHERE token_symbol = ? ALLOW FILTERING";
    const countResult = await client.execute(countQuery, ["AO"]);
    const existingCount = countResult.rows[0].count;

    console.log(`📊 Found ${existingCount} existing AO price records`);

    if (existingCount === 0) {
      console.log("✅ No AO price data to clear");
      return;
    }

    // Clear all AO price data
    // Note: We need to get all records first, then delete them individually
    // because Cassandra requires all partition key columns for DELETE
    console.log("🔄 Fetching AO records to delete...");
    const selectQuery =
      "SELECT date, data_source FROM daily_prices WHERE token_symbol = ? ALLOW FILTERING";
    const selectResult = await client.execute(selectQuery, ["AO"]);

    console.log(`🗑️  Deleting ${selectResult.rows.length} AO price records...`);

    // Delete each record individually
    for (const row of selectResult.rows) {
      const deleteQuery =
        "DELETE FROM daily_prices WHERE token_symbol = ? AND date = ? AND data_source = ?";
      await client.execute(deleteQuery, ["AO", row.date, row.data_source]);
    }

    console.log(`✅ Cleared ${existingCount} AO price records`);
    console.log(
      "💡 You can now run the update-prices job to fetch fresh AO data"
    );
  } catch (error) {
    console.error("❌ Error clearing AO prices:", error.message);
    process.exit(1);
  } finally {
    await client.shutdown();
  }
}

clearAOPrices();
