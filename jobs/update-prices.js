#!/usr/bin/env node

// Load environment variables
require("dotenv").config();

/**
 * Job script to update price data from all sources
 *
 * Runs dedicated fetchers for each token:
 * 1. AR Price Fetcher (CoinGecko - needed for wAR conversion)
 * 2. AO Price Fetcher (GQL + CoinGecko + Pool reserves)
 * 3. ARIO Price Fetcher (GQL + CoinGecko + Pool reserves)
 * 4. PI Price Fetcher (GQL + Pool reserves)
 *
 * Each fetcher handles its own data sources and date ranges
 * Can be run manually or via cron
 */

const { spawn } = require("child_process");
const path = require("path");

function runScript(scriptPath, scriptName) {
  return new Promise((resolve, reject) => {
    console.log(`💰 Running ${scriptName}...`);
    const startTime = Date.now();

    const child = spawn("node", [scriptPath], {
      stdio: "inherit", // This streams output in real-time
      cwd: __dirname,
    });

    child.on("close", (code) => {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      if (code === 0) {
        console.log(`✅ ${scriptName} completed in ${duration}s\n`);
        resolve();
      } else {
        console.error(`❌ ${scriptName} failed with exit code ${code}`);
        reject(new Error(`${scriptName} failed with exit code ${code}`));
      }
    });

    child.on("error", (error) => {
      console.error(`❌ Error running ${scriptName}:`, error);
      reject(error);
    });
  });
}

async function updatePrices() {
  console.log("🚀 Starting price update job");
  console.log(`⏰ Timestamp: ${new Date().toISOString()}\n`);

  const startTime = Date.now();

  try {
    // Run AR price fetcher first (needed for wAR conversion)
    const arPath = path.join(__dirname, "../src/fetchers/ar_price_fetcher.js");
    await runScript(arPath, "AR Price Fetcher");

    // Run AO price fetcher (GQL + CoinGecko + Pool reserves)
    const aoPath = path.join(__dirname, "../src/fetchers/ao_price_fetcher.js");
    await runScript(aoPath, "AO Price Fetcher");

    // Run ARIO price fetcher (GQL + CoinGecko + Pool reserves)
    const arioPath = path.join(
      __dirname,
      "../src/fetchers/ario_price_fetcher.js"
    );
    await runScript(arioPath, "ARIO Price Fetcher");

    // Run PI price fetcher (GQL + Pool reserves)
    const piPath = path.join(__dirname, "../src/fetchers/pi_price_fetcher.js");
    await runScript(piPath, "PI Price Fetcher");

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n✅ Price update job completed in ${duration}s`);
  } catch (error) {
    console.error("❌ Price update job failed:", error.message);
    process.exit(1);
  }
}

// Run the job
updatePrices();
