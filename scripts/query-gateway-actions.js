const { Client } = require("cassandra-driver");

// Database configuration
const client = new Client({
  contactPoints: ["127.0.0.1"],
  localDataCenter: "datacenter1",
  keyspace: "ario_distributions",
});

async function queryGatewayActions() {
  try {
    console.log("🔍 Querying gateway actions...");

    // Connect to database
    await client.connect();
    console.log("✅ Connected to Cassandra database");

    // Get total count
    const countResult = await client.execute(
      "SELECT COUNT(*) FROM gateway_actions"
    );
    const totalCount = countResult.first().count;
    console.log(`📊 Total gateway actions: ${totalCount}`);

    if (totalCount === 0) {
      console.log("📭 No gateway actions found. Run the indexer first.");
      return;
    }

    // Get action statistics
    const allActionsResult = await client.execute(
      "SELECT action, gateway_address FROM gateway_actions"
    );

    const actionStats = {};
    const gatewayStats = new Set();

    allActionsResult.rows.forEach((row) => {
      actionStats[row.action] = (actionStats[row.action] || 0) + 1;
      gatewayStats.add(row.gateway_address);
    });

    console.log("\n📈 Action Statistics:");
    Object.entries(actionStats).forEach(([action, count]) => {
      console.log(`   ${action}: ${count} actions`);
    });

    console.log(`\n🏛️ Unique Gateways: ${gatewayStats.size}`);

    // Get block height range
    const blockRangeResult = await client.execute(
      "SELECT MIN(block_height) as min_block, MAX(block_height) as max_block FROM gateway_actions"
    );
    const minBlock = blockRangeResult.first().min_block;
    const maxBlock = blockRangeResult.first().max_block;

    console.log(`\n📊 Block Height Range: ${minBlock} to ${maxBlock}`);

    // Get recent actions (without ordering due to Cassandra limitations)
    console.log("\n📋 Sample Gateway Actions:");
    const recentResult = await client.execute(
      "SELECT transaction_id, gateway_address, action, auto_stake, block_height, timestamp FROM gateway_actions LIMIT 10"
    );

    recentResult.rows.forEach((row, index) => {
      // Handle timestamp - it might be in seconds or milliseconds
      let dateStr = "Unknown";
      try {
        const timestamp =
          row.timestamp > 1e12 ? row.timestamp : row.timestamp * 1000;
        dateStr = new Date(timestamp).toISOString().split("T")[0];
      } catch (e) {
        dateStr = `Raw: ${row.timestamp}`;
      }

      console.log(`   ${index + 1}. ${row.gateway_address}`);
      console.log(`      Action: ${row.action}`);
      console.log(`      Auto-Stake: ${row.auto_stake}`);
      console.log(`      Block: ${row.block_height} (${dateStr})`);
      console.log(
        `      TX: ${row.transaction_id.substring(
          0,
          8
        )}...${row.transaction_id.substring(-8)}`
      );
      console.log("");
    });

    // Query specific gateway if provided
    const targetGateway = process.argv[2];
    if (targetGateway) {
      console.log(`\n🎯 Querying specific gateway: ${targetGateway}`);
      const specificResult = await client.execute(
        "SELECT * FROM gateway_actions WHERE gateway_address = ? ORDER BY block_height ASC",
        [targetGateway]
      );

      if (specificResult.rows.length > 0) {
        console.log(
          `   Found ${specificResult.rows.length} actions for this gateway:`
        );
        specificResult.rows.forEach((action, index) => {
          const date = new Date(action.timestamp * 1000)
            .toISOString()
            .split("T")[0];
          console.log(
            `   ${index + 1}. ${action.action} (Block ${
              action.block_height
            }, ${date})`
          );
          if (action.auto_stake !== null) {
            console.log(`      Auto-Stake: ${action.auto_stake}`);
          }
          if (action.label) {
            console.log(`      Label: ${action.label}`);
          }
          if (action.fqdn) {
            console.log(`      FQDN: ${action.fqdn}`);
          }
          console.log("");
        });
      } else {
        console.log(`   ❌ No actions found for gateway: ${targetGateway}`);
      }
    }
  } catch (error) {
    console.error("❌ Error during query:", error);
  } finally {
    await client.shutdown();
    console.log("🔌 Database connection closed");
  }
}

// Run the query
queryGatewayActions().catch(console.error);
