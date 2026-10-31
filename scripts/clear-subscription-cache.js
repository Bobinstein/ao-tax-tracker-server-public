#!/usr/bin/env node

/**
 * Clear all subscription cache data from Cassandra
 * This utility removes all cached subscription data from the subscription_cache keyspace
 * Use this when you need to start fresh or after fixing data issues
 */

const cassandra = require("cassandra-driver");

const SUBSCRIPTION_DB = {
  contactPoints: ["localhost"],
  localDataCenter: "datacenter1",
  keyspace: "subscription_cache",
};

async function clearSubscriptionCache() {
  let client = null;

  try {
    console.log("🔌 Connecting to Cassandra...");

    // Connect without keyspace first to check if it exists
    const clientConfig = { ...SUBSCRIPTION_DB };
    delete clientConfig.keyspace;
    client = new cassandra.Client(clientConfig);
    await client.connect();
    console.log("✅ Connected to Cassandra");

    // Check if keyspace exists
    const keyspaceQuery = `
      SELECT keyspace_name FROM system_schema.keyspaces 
      WHERE keyspace_name = ?
    `;
    const keyspaceResult = await client.execute(keyspaceQuery, [
      SUBSCRIPTION_DB.keyspace,
    ]);

    if (keyspaceResult.rows.length === 0) {
      console.log(
        `ℹ️  Keyspace '${SUBSCRIPTION_DB.keyspace}' does not exist. Nothing to clear.`
      );
      return;
    }

    // Switch to the keyspace
    await client.execute(`USE ${SUBSCRIPTION_DB.keyspace}`);
    console.log(`✅ Using keyspace: ${SUBSCRIPTION_DB.keyspace}`);

    // Check if subscriptions table exists
    const tableQuery = `
      SELECT table_name FROM system_schema.tables 
      WHERE keyspace_name = ? AND table_name = 'subscriptions'
    `;
    const tableResult = await client.execute(tableQuery, [
      SUBSCRIPTION_DB.keyspace,
    ]);

    if (tableResult.rows.length === 0) {
      console.log("ℹ️  Subscriptions table does not exist. Nothing to clear.");
      return;
    }

    // Get count of records before clearing
    const countQuery = "SELECT COUNT(*) as count FROM subscriptions";
    const countResult = await client.execute(countQuery);
    const recordCount = countResult.rows[0].count.toNumber();
    console.log(`📊 Found ${recordCount} subscription records in cache`);

    if (recordCount === 0) {
      console.log("ℹ️  Cache is already empty. Nothing to clear.");
      return;
    }

    // Confirm before clearing (if running interactively)
    if (process.stdin.isTTY) {
      const readline = require("readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await new Promise((resolve) => {
        rl.question(
          `⚠️  Are you sure you want to delete ${recordCount} subscription records? (y/N): `,
          resolve
        );
      });
      rl.close();

      if (answer.toLowerCase() !== "y") {
        console.log("❌ Operation cancelled");
        return;
      }
    }

    // TRUNCATE is the fastest way to clear all data from a table
    console.log("🗑️  Clearing subscription cache...");
    await client.execute("TRUNCATE subscriptions");

    console.log(`✅ Successfully cleared ${recordCount} subscription records`);
    console.log(
      "ℹ️  The cache will be repopulated automatically as users make requests"
    );
  } catch (error) {
    console.error("❌ Error clearing subscription cache:", error.message);
    process.exit(1);
  } finally {
    if (client) {
      await client.shutdown();
      console.log("🔌 Disconnected from Cassandra");
    }
  }
}

// Run if called directly
if (require.main === module) {
  console.log("=".repeat(60));
  console.log("  Subscription Cache Clearing Utility");
  console.log("=".repeat(60));
  console.log();

  clearSubscriptionCache()
    .then(() => {
      console.log();
      console.log("✅ Done");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Fatal error:", error);
      process.exit(1);
    });
}

module.exports = { clearSubscriptionCache };
