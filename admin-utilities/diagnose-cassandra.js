#!/usr/bin/env node

/**
 * Cassandra Diagnostic Script
 *
 * This script runs various diagnostic checks on the Cassandra database
 * to help identify connection and configuration issues.
 */

const cassandra = require("cassandra-driver");
const CONFIG = require("../config/database");

async function diagnoseCassandra() {
  console.log("🔍 Cassandra Diagnostic Tool");
  console.log("=============================");

  console.log("\n📋 Configuration:");
  console.log("   Contact Points:", CONFIG.ARIO_DISTRIBUTION_DB.contactPoints);
  console.log("   Keyspace:", CONFIG.ARIO_DISTRIBUTION_DB.keyspace);
  console.log("   Data Center:", CONFIG.ARIO_DISTRIBUTION_DB.localDataCenter);
  console.log(
    "   Connect Timeout:",
    CONFIG.ARIO_DISTRIBUTION_DB.socketOptions.connectTimeout + "ms"
  );
  console.log(
    "   Read Timeout:",
    CONFIG.ARIO_DISTRIBUTION_DB.socketOptions.readTimeout + "ms"
  );

  const client = new cassandra.Client(CONFIG.ARIO_DISTRIBUTION_DB);

  try {
    console.log("\n🔌 Testing connection...");
    await client.connect();
    console.log("✅ Successfully connected to Cassandra!");

    // Test 1: Check if keyspace exists
    console.log("\n🔍 Test 1: Checking keyspace existence...");
    const keyspaceResult = await client.execute(
      "SELECT keyspace_name FROM system_schema.keyspaces WHERE keyspace_name = ?",
      [CONFIG.ARIO_DISTRIBUTION_DB.keyspace]
    );

    if (keyspaceResult.rows.length > 0) {
      console.log("✅ Keyspace exists:", keyspaceResult.rows[0].keyspace_name);
    } else {
      console.log(
        "❌ Keyspace does not exist:",
        CONFIG.ARIO_DISTRIBUTION_DB.keyspace
      );
      console.log("💡 Available keyspaces:");
      const allKeyspaces = await client.execute(
        "SELECT keyspace_name FROM system_schema.keyspaces"
      );
      allKeyspaces.rows.forEach((row) => {
        console.log("   -", row.keyspace_name);
      });
      return;
    }

    // Test 2: Check table existence
    console.log("\n🔍 Test 2: Checking table existence...");
    const tables = [
      "distributions",
      "epoch_metadata",
      "gateway_states",
      "gateway_actions",
    ];

    for (const table of tables) {
      const tableResult = await client.execute(
        "SELECT table_name FROM system_schema.tables WHERE keyspace_name = ? AND table_name = ?",
        [CONFIG.ARIO_DISTRIBUTION_DB.keyspace, table]
      );

      if (tableResult.rows.length > 0) {
        console.log(`✅ Table '${table}' exists`);
      } else {
        console.log(`❌ Table '${table}' does not exist`);
      }
    }

    // Test 3: Check data existence (sampling instead of counting to avoid timeouts)
    console.log("\n🔍 Test 3: Checking data existence...");

    try {
      const distributionsSample = await client.execute(
        "SELECT * FROM distributions LIMIT 1"
      );
      console.log(
        `📊 Distributions table: ${
          distributionsSample.rows.length > 0 ? "has data" : "empty"
        }`
      );
    } catch (error) {
      console.log(`❌ Error sampling distributions: ${error.message}`);
    }

    try {
      const epochSample = await client.execute(
        "SELECT * FROM epoch_metadata LIMIT 1"
      );
      console.log(
        `📊 Epoch metadata table: ${
          epochSample.rows.length > 0 ? "has data" : "empty"
        }`
      );
    } catch (error) {
      console.log(`❌ Error sampling epoch metadata: ${error.message}`);
    }

    try {
      const gatewayStatesSample = await client.execute(
        "SELECT * FROM gateway_states LIMIT 1"
      );
      console.log(
        `📊 Gateway states table: ${
          gatewayStatesSample.rows.length > 0 ? "has data" : "empty"
        }`
      );
    } catch (error) {
      console.log(`❌ Error sampling gateway states: ${error.message}`);
    }

    try {
      const gatewayActionsSample = await client.execute(
        "SELECT * FROM gateway_actions LIMIT 1"
      );
      console.log(
        `📊 Gateway actions table: ${
          gatewayActionsSample.rows.length > 0 ? "has data" : "empty"
        }`
      );
    } catch (error) {
      console.log(`❌ Error sampling gateway actions: ${error.message}`);
    }

    // Test 4: Check cluster information
    console.log("\n🔍 Test 4: Checking cluster information...");
    const clusterInfo = await client.execute(
      "SELECT cluster_name FROM system.local"
    );
    if (clusterInfo.rows.length > 0) {
      console.log("🏢 Cluster name:", clusterInfo.rows[0].cluster_name);
    }

    const hostInfo = await client.execute(
      "SELECT host_id, release_version FROM system.local"
    );
    if (hostInfo.rows.length > 0) {
      console.log("🖥️  Host ID:", hostInfo.rows[0].host_id);
      console.log("📦 Cassandra version:", hostInfo.rows[0].release_version);
    }

    console.log("\n✅ All diagnostic tests completed successfully!");
  } catch (error) {
    console.error("\n❌ Diagnostic failed:", error.message);
    console.error("🔍 Full error details:", error);

    if (error.message.includes("Server failure during read query")) {
      console.log("\n💡 This error suggests:");
      console.log("   • Cassandra is running but having internal issues");
      console.log("   • Network connectivity problems");
      console.log("   • Resource constraints (memory, disk space)");
      console.log("   • Corrupted data or schema issues");
    } else if (error.message.includes("ECONNREFUSED")) {
      console.log("\n💡 This error suggests:");
      console.log("   • Cassandra is not running");
      console.log("   • Wrong port or host configuration");
      console.log("   • Firewall blocking the connection");
    } else if (error.message.includes("timeout")) {
      console.log("\n💡 This error suggests:");
      console.log("   • Cassandra is overloaded");
      console.log("   • Network latency issues");
      console.log("   • Resource constraints");
    }

    console.log("\n🔧 Troubleshooting steps:");
    console.log("   1. Check Cassandra status: systemctl status cassandra");
    console.log("   2. Check Cassandra logs: journalctl -u cassandra -f");
    console.log("   3. Check system resources: free -h && df -h");
    console.log("   4. Test with cqlsh: cqlsh -e 'DESCRIBE KEYSPACES;'");
    console.log("   5. Restart Cassandra: systemctl restart cassandra");
  } finally {
    console.log("\n🔌 Closing connection...");
    await client.shutdown();
    console.log("✅ Connection closed");
  }
}

diagnoseCassandra();
