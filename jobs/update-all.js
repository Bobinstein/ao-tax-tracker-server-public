#!/usr/bin/env node

// Load environment variables
require("dotenv").config();

/**
 * Job script to update all data: distributions + prices
 * Can be run manually or via cron
 */

const { exec } = require("child_process");
const util = require("util");
const path = require("path");

const execPromise = util.promisify(exec);

async function updateAll() {
  console.log("🚀 Starting full update job (distributions + prices)");
  console.log(`⏰ Timestamp: ${new Date().toISOString()}\n`);

  const startTime = Date.now();

  try {
    // ========================================================================
    // DISTRIBUTIONS
    // ========================================================================
    console.log("=".repeat(70));
    console.log("UPDATING DISTRIBUTIONS");
    console.log("=".repeat(70) + "\n");

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

    // ========================================================================
    // PRICES
    // ========================================================================
    console.log("=".repeat(70));
    console.log("UPDATING PRICES");
    console.log("=".repeat(70) + "\n");

    // Run AO price fetcher
    console.log("💰 Running AO price fetcher...");
    const aoPricePath = path.join(
      __dirname,
      "../src/fetchers/ao_price_fetcher.js"
    );
    const { stdout: aoPriceStdout, stderr: aoPriceStderr } = await execPromise(
      `node ${aoPricePath}`,
      { maxBuffer: 50 * 1024 * 1024 } // 50MB buffer
    );
    if (aoPriceStdout) console.log(aoPriceStdout);
    if (aoPriceStderr) console.error(aoPriceStderr);
    console.log("✅ AO price fetcher completed\n");

    // Run ARIO price fetcher
    console.log("💰 Running ARIO price fetcher...");
    const arioPricePath = path.join(
      __dirname,
      "../src/fetchers/ario_price_fetcher.js"
    );
    const { stdout: arioPriceStdout, stderr: arioPriceStderr } =
      await execPromise(
        `node ${arioPricePath}`,
        { maxBuffer: 50 * 1024 * 1024 } // 50MB buffer
      );
    if (arioPriceStdout) console.log(arioPriceStdout);
    if (arioPriceStderr) console.error(arioPriceStderr);
    console.log("✅ ARIO price fetcher completed\n");

    // Run PI price fetcher
    console.log("💰 Running PI price fetcher...");
    const piPricePath = path.join(
      __dirname,
      "../src/fetchers/pi_price_fetcher.js"
    );
    const { stdout: piPriceStdout, stderr: piPriceStderr } = await execPromise(
      `node ${piPricePath}`,
      { maxBuffer: 50 * 1024 * 1024 } // 50MB buffer
    );
    if (piPriceStdout) console.log(piPriceStdout);
    if (piPriceStderr) console.error(piPriceStderr);
    console.log("✅ PI price fetcher completed\n");

    // ========================================================================
    // SUMMARY
    // ========================================================================
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log("=".repeat(70));
    console.log(`✅ Full update job completed in ${duration}s`);
    console.log("=".repeat(70));
    console.log("📊 Updated:");
    console.log("   - AO Distributions");
    console.log("   - PI Distributions");
    console.log("   - ARIO Gateway Actions");
    console.log("   - ARIO Distributions");
    console.log("   - AR Prices (CoinGecko)");
    console.log("   - AO Prices (GQL + CoinGecko + Pool)");
    console.log("   - ARIO Prices (GQL + CoinGecko + Pool)");
    console.log("   - PI Prices (GQL + Pool)");
  } catch (error) {
    console.error("❌ Full update job failed:", error.message);
    process.exit(1);
  }
}

// Run the job
updateAll();
