#!/usr/bin/env node

/**
 * Admin Utility: Clear PI Distribution Data
 *
 * This script clears all PI distribution data from the pi_distributions table.
 * Use this when you need to refresh PI distribution data completely.
 *
 * WARNING: This will delete all PI distribution records!
 *
 * Usage: node admin-utilities/clear-pi-distributions.js
 */

const cassandra = require("cassandra-driver");
const CONFIG = require("../config/database");

async function clearPIDistributions() {
  console.log("🗑️  Clearing PI distribution data...");
  console.log("⚠️  WARNING: This will delete all PI distribution records!");

  const client = new cassandra.Client(CONFIG.PI_DISTRIBUTION_DB);
  await client.connect();

  try {
    // Check if table has data by sampling instead of counting to avoid timeouts
    console.log("🔍 Sampling PI distributions table...");
    const sampleResult = await client.execute(
      "SELECT * FROM distributions LIMIT 1"
    );
    const hasData = sampleResult.rows.length > 0;

    if (!hasData) {
      console.log("✅ No PI distribution data to clear");
      return;
    }

    console.log("📊 PI distributions table has data");

    // Clear all PI distribution data and tracking tables
    console.log("🗑️  Clearing distributions table...");
    await client.execute("TRUNCATE distributions");

    console.log("🗑️  Clearing transactions table...");
    await client.execute("TRUNCATE transactions");

    console.log("🗑️  Clearing processed_files table...");
    await client.execute("TRUNCATE processed_files");

    console.log("🗑️  Clearing test_wallet_balances table...");
    await client.execute("TRUNCATE test_wallet_balances");

    console.log(`✅ Cleared all PI distribution data and tracking tables`);
    console.log(
      "💡 You can now run the update-distributions job to fetch fresh PI distribution data"
    );
  } catch (error) {
    console.error("❌ Error clearing PI distributions:", error.message);
    process.exit(1);
  } finally {
    await client.shutdown();
  }
}

clearPIDistributions();
