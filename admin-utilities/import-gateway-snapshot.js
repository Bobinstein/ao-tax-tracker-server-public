#!/usr/bin/env node

/**
 * Admin Utility: Import Gateway Snapshot
 *
 * This script imports the gateway snapshot data into the gateway_states table
 * in the ario_distributions keyspace. This provides the initial state for
 * the hybrid gateway state system.
 *
 * Usage: node admin-utilities/import-gateway-snapshot.js
 */

const cassandra = require("cassandra-driver");
const fs = require("fs");
const path = require("path");
const CONFIG = require("../config/database");

async function importGatewaySnapshot() {
  console.log("📸 Importing gateway snapshot...");

  // Load the snapshot file
  const snapshotPath = path.join(
    __dirname,
    "../data/gateway-snapshot_1738271904625.json"
  );

  if (!fs.existsSync(snapshotPath)) {
    console.error("❌ Gateway snapshot file not found:", snapshotPath);
    process.exit(1);
  }

  let snapshotData;
  try {
    const fileContent = fs.readFileSync(snapshotPath, "utf8");
    snapshotData = JSON.parse(fileContent);
    console.log(`📊 Loaded ${snapshotData.length} gateways from snapshot`);
  } catch (error) {
    console.error("❌ Error reading snapshot file:", error.message);
    process.exit(1);
  }

  // Connect to the ario_distributions keyspace
  const client = new cassandra.Client({
    contactPoints: ["127.0.0.1"],
    localDataCenter: "datacenter1",
    keyspace: "ario_distributions",
  });

  try {
    await client.connect();
    console.log("✅ Connected to ario_distributions keyspace");

    // Create the gateway_states table if it doesn't exist
    console.log("🏗️  Creating gateway_states table...");
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS gateway_states (
        gateway_address text PRIMARY KEY,
        observer_address text,
        operator_stake text,
        port text,
        protocol text,
        min_delegated_stake text,
        fqdn text,
        delegate_reward_share_ratio text,
        note text,
        auto_stake boolean,
        allow_delegated_staking boolean,
        label text,
        properties text,
        start_timestamp text,
        status text
      )
    `;
    await client.execute(createTableQuery);
    console.log("✅ Gateway states table ready");

    // Check if data already exists
    const countQuery = "SELECT COUNT(*) FROM gateway_states";
    const countResult = await client.execute(countQuery);
    const existingCount = countResult.first().count;

    if (existingCount > 0) {
      console.log(`⚠️  Found ${existingCount} existing gateway states`);
      console.log("🗑️  Clearing existing data...");
      await client.execute("TRUNCATE gateway_states");
      console.log("✅ Cleared existing data");
    }

    // Import each gateway
    console.log("📥 Importing gateway states...");
    let imported = 0;
    let errors = 0;

    for (const gateway of snapshotData) {
      try {
        const insertQuery = `
          INSERT INTO gateway_states (
            gateway_address, observer_address, operator_stake, port, protocol,
            min_delegated_stake, fqdn, delegate_reward_share_ratio, note,
            auto_stake, allow_delegated_staking, label, properties,
            start_timestamp, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const params = [
          gateway.gatewayAddress,
          gateway.observerAddress,
          gateway.operatorStake.toString(),
          gateway.settings.port.toString(),
          gateway.settings.protocol,
          gateway.settings.minDelegatedStake.toString(),
          gateway.settings.fqdn,
          gateway.settings.delegateRewardShareRatio.toString(),
          gateway.settings.note,
          gateway.settings.autoStake,
          gateway.settings.allowDelegatedStaking,
          gateway.settings.label,
          gateway.settings.properties,
          gateway.startTimestamp.toString(),
          gateway.status || "active",
        ];

        await client.execute(insertQuery, params, { prepare: true });
        imported++;

        if (imported % 50 === 0) {
          console.log(
            `   Imported ${imported}/${snapshotData.length} gateways...`
          );
        }
      } catch (error) {
        console.error(
          `❌ Error importing gateway ${gateway.gatewayAddress}:`,
          error.message
        );
        errors++;
      }
    }

    console.log(`\n✅ Import completed:`);
    console.log(`   Imported: ${imported} gateways`);
    console.log(`   Errors: ${errors} gateways`);
    console.log(`   Total in snapshot: ${snapshotData.length} gateways`);

    if (errors === 0) {
      console.log("\n🎉 All gateways imported successfully!");
      console.log("💡 The hybrid gateway state system is now ready to use");
    } else {
      console.log(
        `\n⚠️  ${errors} gateways failed to import. Check the errors above.`
      );
    }
  } catch (error) {
    console.error("❌ Error during import:", error.message);
    process.exit(1);
  } finally {
    await client.shutdown();
    console.log("🔌 Database connection closed");
  }
}

// Run the import
importGatewaySnapshot();
