#!/usr/bin/env node

/**
 * Admin Utility: Reset Gateway Data
 *
 * This script clears all gateway actions and then imports the gateway snapshot
 * to establish a clean baseline for the hybrid gateway state system.
 *
 * This is useful when you need to start fresh with gateway data or when
 * the gateway actions have become corrupted or inconsistent.
 *
 * WARNING: This will delete all gateway actions and states!
 *
 * Usage: node admin-utilities/reset-gateway-data.js
 */

const cassandra = require("cassandra-driver");
const { execSync } = require("child_process");
const CONFIG = require("../config/database");

async function resetGatewayData() {
  console.log("🔄 Resetting gateway data...");
  console.log("⚠️  WARNING: This will delete all gateway actions and states!");
  console.log("ℹ️  This will establish a clean baseline from the snapshot");

  const client = new cassandra.Client(CONFIG.ARIO_DISTRIBUTION_DB);

  try {
    console.log("🔌 Connecting to Cassandra...");
    await client.connect();
    console.log("✅ Connected to Cassandra successfully");

    // Check if tables exist and have data
    console.log("🔍 Checking existing gateway data...");

    let gatewayStatesHasData = false;
    let gatewayActionsHasData = false;

    try {
      const gatewayStatesSample = await client.execute(
        "SELECT * FROM gateway_states LIMIT 1"
      );
      gatewayStatesHasData = gatewayStatesSample.rows.length > 0;
      console.log(
        `📊 Gateway states table: ${
          gatewayStatesHasData ? "has data" : "empty"
        }`
      );
    } catch (error) {
      console.log(`❌ Error sampling gateway states: ${error.message}`);
    }

    try {
      const gatewayActionsSample = await client.execute(
        "SELECT * FROM gateway_actions LIMIT 1"
      );
      gatewayActionsHasData = gatewayActionsSample.rows.length > 0;
      console.log(
        `📊 Gateway actions table: ${
          gatewayActionsHasData ? "has data" : "empty"
        }`
      );
    } catch (error) {
      console.log(`❌ Error sampling gateway actions: ${error.message}`);
    }

    if (!gatewayStatesHasData && !gatewayActionsHasData) {
      console.log("✅ No gateway data to clear");
    } else {
      // Clear gateway actions table
      if (gatewayActionsHasData) {
        console.log("🗑️  Clearing gateway actions table...");
        await client.execute("TRUNCATE gateway_actions");
        console.log("✅ Cleared gateway actions table");
      }

      // Clear gateway states table
      if (gatewayStatesHasData) {
        console.log("🗑️  Clearing gateway states table...");
        await client.execute("TRUNCATE gateway_states");
        console.log("✅ Cleared gateway states table");
      }
    }

    console.log("\n🔌 Closing connection...");
    await client.shutdown();
    console.log("✅ Connection closed");

    // Now run the gateway snapshot import
    console.log("\n📸 Importing gateway snapshot...");
    try {
      execSync("node admin-utilities/import-gateway-snapshot.js", {
        stdio: "inherit",
        cwd: process.cwd(),
      });
      console.log("✅ Gateway snapshot imported successfully");
    } catch (error) {
      console.error("❌ Error importing gateway snapshot:", error.message);
      process.exit(1);
    }

    console.log("\n🎉 Gateway data reset completed successfully!");
    console.log(
      "💡 You can now run the gateway actions indexer to build historical state"
    );
    console.log(
      "   Command: node src/indexers/ario_gateway_mainnet_indexer.js"
    );
  } catch (error) {
    console.error("❌ Error resetting gateway data:", error.message);
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
  }
}

resetGatewayData();
