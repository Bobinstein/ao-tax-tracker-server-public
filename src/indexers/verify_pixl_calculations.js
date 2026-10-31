#!/usr/bin/env node

/**
 * PIXL Verification Script
 *
 * Compares our calculated distributions (stored in Cassandra) against
 * the actual Output.data from the contract during the verification period
 * (blocks 1679720-1770159 when print statements were active).
 */

const cassandra = require("cassandra-driver");
const aoconnect = require("@permaweb/aoconnect");

const PIXL_TOKEN = "DM3FoZUq_yebASPhgd8pEIRIzDW6muXEhxz5-JwbZwo";

// Use default public CU - verification period should be within checkpoint range
const aoResult = aoconnect.result;
const VERIFICATION_START = 1679720;
const VERIFICATION_END = 1770159;

const client = new cassandra.Client({
  contactPoints: ["127.0.0.1"],
  localDataCenter: "datacenter1",
  keyspace: "ar_tax_tracker",
});

/**
 * Parse allocation from AO Output.data (Lua table format with ANSI codes)
 */
function parseAllocationOutput(outputData) {
  const allocations = new Map();
  if (!outputData || typeof outputData !== "string") return allocations;

  // Remove ANSI color codes
  const cleanData = outputData.replace(/\x1b\[[0-9;]*m/g, "");

  // Parse: address = amount
  const regex = /([a-zA-Z0-9_-]{43})\s*=\s*(\d+)/g;
  let match;
  while ((match = regex.exec(cleanData)) !== null) {
    allocations.set(match[1], BigInt(match[2]));
  }

  return allocations;
}

async function main() {
  console.log("=".repeat(70));
  console.log("PIXL Distribution Verification");
  console.log("Comparing DB calculations vs On-Chain Output.data");
  console.log(
    `Verification period: blocks ${VERIFICATION_START}-${VERIFICATION_END}`,
  );
  console.log("=".repeat(70));

  await client.connect();
  console.log("\n✅ Connected to Cassandra\n");

  // Get all distribution blocks in the verification range
  const blocksQuery = `
    SELECT DISTINCT distribution_block FROM pixl_distributions_by_block
  `;

  const blocksResult = await client.execute(blocksQuery);
  const verificationBlocks = blocksResult.rows
    .map((r) => r.distribution_block)
    .filter((b) => b >= VERIFICATION_START && b <= VERIFICATION_END)
    .sort((a, b) => a - b);

  console.log(
    `Found ${verificationBlocks.length} distribution blocks in verification range\n`,
  );

  if (verificationBlocks.length === 0) {
    console.log("No blocks to verify.");
    await client.shutdown();
    return;
  }

  // We need the tx_id for each block to fetch Output.data
  // Get it from pixl_distributions table
  const txQuery = `
    SELECT distribution_block, run_rewards_tx_id, wallet_address, amount_units
    FROM pixl_distributions
    WHERE distribution_block IN ?
    ALLOW FILTERING
  `;

  // Cassandra doesn't support IN on non-partition key well, so let's query differently
  // Query each block individually

  let verified = 0;
  let failed = 0;
  let skipped = 0;
  const mismatches = [];

  for (const block of verificationBlocks) {
    // Get our stored distributions for this block from pixl_distributions_by_block
    const distQuery = `
      SELECT wallet_address, amount_units
      FROM pixl_distributions_by_block
      WHERE distribution_block = ?
    `;

    const distResult = await client.execute(distQuery, [block], {
      prepare: true,
    });

    if (distResult.rows.length === 0) {
      console.log(`⏭️  Block ${block}: No distributions found`);
      skipped++;
      continue;
    }

    // Get tx_id from pixl_distributions table (which has the tx_id)
    const txIdQuery = `
      SELECT run_rewards_tx_id FROM pixl_distributions
      WHERE distribution_block = ?
      LIMIT 1
      ALLOW FILTERING
    `;

    const txResult = await client.execute(txIdQuery, [block], {
      prepare: true,
    });
    if (txResult.rows.length === 0 || !txResult.rows[0].run_rewards_tx_id) {
      console.log(`⏭️  Block ${block}: No tx_id found`);
      skipped++;
      continue;
    }

    const txId = txResult.rows[0].run_rewards_tx_id;

    // Build our calculated allocation map
    const ourAllocation = new Map();
    for (const row of distResult.rows) {
      ourAllocation.set(row.wallet_address, BigInt(row.amount_units));
    }

    // Fetch actual Output.data from chain
    try {
      const res = await aoResult({
        process: PIXL_TOKEN,
        message: txId,
      });

      // Check for Invalid-Reward-Interval
      const invalidMsg = res.Messages?.find((m) =>
        m.Tags?.some(
          (t) => t.name === "Action" && t.value === "Invalid-Reward-Interval",
        ),
      );
      if (invalidMsg) {
        console.log(
          `⏭️  Block ${block}: Invalid-Reward-Interval (expected skip)`,
        );
        skipped++;
        continue;
      }

      const outputData = res.Output?.data;
      if (!outputData) {
        console.log(`⚠️  Block ${block}: No Output.data available`);
        skipped++;
        continue;
      }

      const actualAllocation = parseAllocationOutput(outputData);

      if (actualAllocation.size === 0) {
        console.log(`⚠️  Block ${block}: Could not parse Output.data`);
        skipped++;
        continue;
      }

      // Compare allocations
      const blockMismatches = [];
      const allAddresses = new Set([
        ...ourAllocation.keys(),
        ...actualAllocation.keys(),
      ]);

      for (const addr of allAddresses) {
        const ours = ourAllocation.get(addr) || BigInt(0);
        const actual = actualAllocation.get(addr) || BigInt(0);

        // Allow small rounding differences (up to 1 unit)
        const diff =
          ours > actual ? Number(ours - actual) : Number(actual - ours);
        if (diff > 1) {
          blockMismatches.push({
            address: addr,
            calculated: ours.toString(),
            actual: actual.toString(),
            diff,
          });
        }
      }

      if (blockMismatches.length === 0) {
        console.log(
          `✅ Block ${block}: Verified (${ourAllocation.size} recipients match)`,
        );
        verified++;
      } else {
        console.log(
          `❌ Block ${block}: ${blockMismatches.length} mismatches out of ${allAddresses.size} addresses`,
        );
        blockMismatches.slice(0, 3).forEach((m) => {
          console.log(
            `   ${m.address.slice(0, 12)}...: ours=${m.calculated} actual=${m.actual} (diff=${m.diff})`,
          );
        });
        failed++;
        mismatches.push({
          block,
          txId,
          totalAddresses: allAddresses.size,
          mismatches: blockMismatches,
        });
      }
    } catch (error) {
      console.log(
        `⚠️  Block ${block}: Error fetching Output.data - ${error.message}`,
      );
      skipped++;
    }

    // Small delay to avoid rate limiting
    await new Promise((r) => setTimeout(r, 100));
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("Verification Summary");
  console.log("=".repeat(70));
  console.log(`✅ Verified: ${verified}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`⏭️  Skipped: ${skipped}`);

  if (mismatches.length > 0) {
    const fs = require("fs");
    const path = require("path");
    const outFile = path.join(
      __dirname,
      "../../logs/pixl-verification-results.json",
    );
    fs.writeFileSync(outFile, JSON.stringify(mismatches, null, 2));
    console.log(`\n📁 Mismatch details saved to: ${outFile}`);
  }

  await client.shutdown();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
