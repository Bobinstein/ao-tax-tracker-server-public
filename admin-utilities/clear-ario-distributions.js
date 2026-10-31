#!/usr/bin/env node

/**
 * Admin Utility: Clear ARIO Distribution Data
 *
 * This script clears all ARIO distribution data from the distributions and epoch_metadata tables.
 * It does NOT clear gateway_states or gateway_actions tables (gateway status data).
 * Use this when you need to refresh ARIO distribution data completely.
 *
 * WARNING: This will delete all ARIO distribution records!
 *
 * Usage: node admin-utilities/clear-ario-distributions.js
 */

const cassandra = require("cassandra-driver");
const CONFIG = require("../config/database");

async function clearARIODistributions() {
  console.log("🗑️  Clearing ARIO distribution data...");
  console.log("⚠️  WARNING: This will delete all ARIO distribution records!");
  console.log("ℹ️  Note: Gateway states and actions will be preserved");

  const client = new cassandra.Client(CONFIG.ARIO_DISTRIBUTION_DB);

  try {
    console.log("🔌 Connecting to Cassandra...");
    await client.connect();
    console.log("✅ Connected to Cassandra successfully");

    // Test connection with a simple query first
    console.log("🔍 Testing connection...");
    await client.execute(
      "SELECT keyspace_name FROM system_schema.keyspaces WHERE keyspace_name = ?",
      [CONFIG.ARIO_DISTRIBUTION_DB.keyspace]
    );

    // Check if tables have data by sampling instead of counting all records
    console.log("📊 Checking for existing data...");

    let distributionsHasData = false;
    let epochMetadataHasData = false;

    try {
      // Sample a few records from distributions table
      console.log("🔍 Sampling distributions table...");
      const distributionsSample = await client.execute(
        "SELECT * FROM distributions LIMIT 1"
      );
      distributionsHasData = distributionsSample.rows.length > 0;
      console.log(
        `📊 Distributions table: ${distributionsHasData ? "has data" : "empty"}`
      );
    } catch (error) {
      console.log(`❌ Error sampling distributions: ${error.message}`);
    }

    try {
      // Sample a few records from epoch_metadata table
      console.log("🔍 Sampling epoch_metadata table...");
      const epochMetadataSample = await client.execute(
        "SELECT * FROM epoch_metadata LIMIT 1"
      );
      epochMetadataHasData = epochMetadataSample.rows.length > 0;
      console.log(
        `📊 Epoch metadata table: ${
          epochMetadataHasData ? "has data" : "empty"
        }`
      );
    } catch (error) {
      console.log(`❌ Error sampling epoch metadata: ${error.message}`);
    }

    if (!distributionsHasData && !epochMetadataHasData) {
      console.log("✅ No ARIO distribution data to clear");
      return;
    }

    // Clear distributions table
    if (distributionsHasData) {
      console.log("🗑️  Clearing distributions table...");
      await client.execute("TRUNCATE distributions");
      console.log("✅ Cleared distributions table");
    }

    // Clear epoch_metadata table
    if (epochMetadataHasData) {
      console.log("🗑️  Clearing epoch_metadata table...");
      await client.execute("TRUNCATE epoch_metadata");
      console.log("✅ Cleared epoch_metadata table");
    }

    console.log("\n✅ ARIO distribution data cleared successfully");
    console.log(
      "💡 You can now run the update-distributions job to fetch fresh ARIO distribution data"
    );
    console.log("🔒 Gateway states and actions were preserved");
  } catch (error) {
    console.error("❌ Error clearing ARIO distributions:", error.message);
    console.error("🔍 Full error details:", error);

    if (error.message.includes("Server failure during read query")) {
      console.log("\n💡 Troubleshooting suggestions:");
      console.log(
        "   • Check if Cassandra is running: systemctl status cassandra"
      );
      console.log("   • Check Cassandra logs: journalctl -u cassandra -f");
      console.log("   • Verify network connectivity to Cassandra");
      console.log(
        "   • Check if the keyspace exists: cqlsh -e 'DESCRIBE KEYSPACES;'"
      );
    }

    process.exit(1);
  } finally {
    console.log("🔌 Closing connection...");
    await client.shutdown();
    console.log("✅ Connection closed");
  }
}

clearARIODistributions();
