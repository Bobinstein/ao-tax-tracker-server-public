#!/usr/bin/env node

// Load environment variables
require("dotenv").config();

/**
 * Job script to update AO and PI distributions
 * Can be run manually or via cron
 */

const { exec } = require("child_process");
const util = require("util");
const path = require("path");

const execPromise = util.promisify(exec);

async function updateDistributions() {
  console.log("🚀 Starting distribution update job");
  console.log(`⏰ Timestamp: ${new Date().toISOString()}\n`);

  const startTime = Date.now();

  try {
    // Run AO distribution indexer
    console.log("📊 Running AO distribution indexer...");
    const aoIndexerPath = path.join(
      __dirname,
      "../src/indexers/ao_distribution_indexer_cassandra.js"
    );
    const { stdout: aoStdout, stderr: aoStderr } = await execPromise(
      `node ${aoIndexerPath}`,
      { maxBuffer: 50 * 1024 * 1024 } // 50MB buffer
    );
    if (aoStdout) console.log(aoStdout);
    if (aoStderr) console.error(aoStderr);

    console.log("✅ AO distribution indexer completed\n");

    // Run PI distribution indexer
    console.log("📊 Running PI distribution indexer...");
    const piIndexerPath = path.join(
      __dirname,
      "../src/indexers/pi_distribution_indexer_cassandra.js"
    );
    const { stdout: piStdout, stderr: piStderr } = await execPromise(
      `node ${piIndexerPath}`,
      { maxBuffer: 50 * 1024 * 1024 } // 50MB buffer
    );
    if (piStdout) console.log(piStdout);
    if (piStderr) console.error(piStderr);

    console.log("✅ PI distribution indexer completed\n");

    // Run ARIO gateway mainnet indexer
    console.log("📊 Running ARIO gateway mainnet indexer...");
    const arioGatewayIndexerPath = path.join(
      __dirname,
      "../src/indexers/ario_gateway_mainnet_indexer.js"
    );
    const { stdout: arioGatewayStdout, stderr: arioGatewayStderr } =
      await execPromise(
        `node ${arioGatewayIndexerPath}`,
        { maxBuffer: 50 * 1024 * 1024 } // 50MB buffer
      );
    if (arioGatewayStdout) console.log(arioGatewayStdout);
    if (arioGatewayStderr) console.error(arioGatewayStderr);

    console.log("✅ ARIO gateway mainnet indexer completed\n");

    // Run ARIO distribution indexer
    console.log("📊 Running ARIO distribution indexer...");
    const arioDistributionIndexerPath = path.join(
      __dirname,
      "../src/indexers/ario_distribution_indexer_cassandra.js"
    );
    const { stdout: arioDistributionStdout, stderr: arioDistributionStderr } =
      await execPromise(
        `node ${arioDistributionIndexerPath}`,
        { maxBuffer: 50 * 1024 * 1024 } // 50MB buffer
      );
    if (arioDistributionStdout) console.log(arioDistributionStdout);
    if (arioDistributionStderr) console.error(arioDistributionStderr);

    console.log("✅ ARIO distribution indexer completed\n");

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n✅ Distribution update job completed in ${duration}s`);
  } catch (error) {
    console.error("❌ Distribution update job failed:", error.message);
    process.exit(1);
  }
}

// Run the job
updateDistributions();
