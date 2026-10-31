#!/usr/bin/env node

const cassandra = require("cassandra-driver");

const client = new cassandra.Client({
  contactPoints: ["localhost"],
  localDataCenter: "datacenter1",
  keyspace: "ao_price_data",
});

async function clearARPrices() {
  try {
    console.log("🔌 Connecting to Cassandra...");
    await client.connect();
    console.log("✅ Connected to Cassandra");

    // Clear all AR price data
    // Note: We need to get all records first, then delete them individually
    // because Cassandra requires all partition key columns for DELETE
    console.log("🔄 Fetching AR records to delete...");
    const selectQuery =
      "SELECT date, data_source FROM daily_prices WHERE token_symbol = ? ALLOW FILTERING";
    const selectResult = await client.execute(selectQuery, ["AR"]);

    console.log(`🗑️  Deleting ${selectResult.rows.length} AR price records...`);

    // Delete each record individually
    for (const row of selectResult.rows) {
      const deleteQuery =
        "DELETE FROM daily_prices WHERE token_symbol = ? AND date = ? AND data_source = ?";
      await client.execute(deleteQuery, ["AR", row.date, row.data_source]);
    }

    console.log("✅ Successfully cleared all AR price data");
  } catch (error) {
    console.error("❌ Error clearing AR prices:", error.message);
    process.exit(1);
  } finally {
    await client.shutdown();
    console.log("🔌 Disconnected from Cassandra");
  }
}

// Run the script
clearARPrices();
