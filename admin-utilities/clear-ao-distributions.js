#!/usr/bin/env node

/**
 * Admin Utility: Clear AO Distribution Data
 *
 * This script clears all AO distribution data from the ao_distributions table.
 * Use this when you need to refresh AO distribution data completely.
 *
 * WARNING: This will delete all AO distribution records!
 *
 * Usage: node admin-utilities/clear-ao-distributions.js
 */

const cassandra = require("cassandra-driver");
const CONFIG = require("../config/database");

async function clearAODistributions() {
  console.log("🗑️  Clearing AO distribution data...");
  console.log("⚠️  WARNING: This will delete all AO distribution records!");

  const client = new cassandra.Client(CONFIG.AO_DISTRIBUTION_DB);
  await client.connect();

  try {
    // Check if table has data by sampling instead of counting to avoid timeouts
    console.log("🔍 Sampling AO distributions table...");
    const sampleResult = await client.execute(
      "SELECT * FROM distributions LIMIT 1"
    );
    const hasData = sampleResult.rows.length > 0;

    if (!hasData) {
      console.log("✅ No AO distribution data to clear");
      return;
    }

    console.log("📊 AO distributions table has data");

    // Clear all AO distribution data and tracking tables
    console.log("🗑️  Clearing distributions table...");
    await client.execute("TRUNCATE distributions");

    console.log("🗑️  Clearing transactions table...");
    await client.execute("TRUNCATE transactions");

    console.log("🗑️  Clearing processed_files table...");
    await client.execute("TRUNCATE processed_files");

    console.log("🗑️  Clearing test_wallet_balances table...");
    await client.execute("TRUNCATE test_wallet_balances");

    console.log(`✅ Cleared all AO distribution data and tracking tables`);
    console.log(
      "💡 You can now run the update-distributions job to fetch fresh AO distribution data"
    );
  } catch (error) {
    console.error("❌ Error clearing AO distributions:", error.message);
    process.exit(1);
  } finally {
    await client.shutdown();
  }
}

clearAODistributions();
