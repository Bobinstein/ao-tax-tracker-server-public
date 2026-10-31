#!/usr/bin/env node

/**
 * Admin Utility: Import Historical AR Prices from Yahoo Finance
 *
 * This script fetches historical AR prices from Yahoo Finance for dates
 * beyond CoinGecko's 365-day limit. Uses yahoo-finance2 npm package.
 *
 * Usage:
 *   node admin-utilities/import-historical-ar-prices.js --start 2024-01-01 --end 2024-12-31
 *   node admin-utilities/import-historical-ar-prices.js --start 2024-06-01 --end 2024-08-31
 */

const cassandra = require("cassandra-driver");
const CONFIG = require("../config/database");

// Check if yahoo-finance2 is available
let YahooFinance;
try {
  YahooFinance = require("yahoo-finance2").default;
} catch (error) {
  console.error("❌ yahoo-finance2 package not found!");
  console.error("   Install with: npm install yahoo-finance2");
  console.error("   Or: yarn add yahoo-finance2");
  process.exit(1);
}

async function importHistoricalARPrices(startDate, endDate) {
  console.log("📊 Importing historical AR prices from Yahoo Finance");
  console.log(`📅 Date range: ${startDate} to ${endDate}`);

  const client = new cassandra.Client(CONFIG.PRICE_DB);
  await client.connect();

  try {
    // Initialize Yahoo Finance client
    const yahooFinance = new YahooFinance();

    // AR ticker on Yahoo Finance - try different formats
    // Yahoo Finance uses format like "AR-USD" for crypto
    const tickers = ["AR-USD", "ARWEAVE-USD"];
    let ticker = null;
    let historicalData = null;

    // Try to find the correct ticker
    for (const testTicker of tickers) {
      try {
        console.log(`\n🔍 Testing ticker: ${testTicker}...`);
        await yahooFinance.quote(testTicker);
        ticker = testTicker;
        console.log(`   ✅ Found valid ticker: ${ticker}`);
        break;
      } catch (error) {
        console.log(`   ❌ ${testTicker} not found`);
      }
    }

    if (!ticker) {
      console.error("❌ AR token not found on Yahoo Finance");
      console.error("   Tried: AR-USD, ARWEAVE-USD");
      console.error(
        "   Consider using an alternative data source or manually importing prices"
      );
      return;
    }

    // Convert dates to Date objects
    const start = new Date(startDate);
    const end = new Date(endDate);

    // Fetch historical data using chart() API (historical() is deprecated)
    try {
      console.log(`\n📊 Fetching historical data for ${ticker}...`);
      const chartResult = await yahooFinance.chart(ticker, {
        period1: Math.floor(start.getTime() / 1000),
        period2: Math.floor(end.getTime() / 1000),
        interval: "1d",
      });

      // chart() returns { meta: {...}, quotes: [...] } format
      if (
        chartResult &&
        chartResult.quotes &&
        Array.isArray(chartResult.quotes)
      ) {
        historicalData = chartResult.quotes;
      } else {
        console.error("❌ Unexpected data format from Yahoo Finance");
        console.error("   Expected chartResult.quotes array");
        return;
      }
    } catch (error) {
      console.error(`❌ Error fetching from Yahoo Finance: ${error.message}`);
      console.error("   Consider using an alternative data source");
      return;
    }

    if (!historicalData || historicalData.length === 0) {
      console.log("⚠️  No data returned from Yahoo Finance");
      return;
    }

    console.log(`   ✅ Fetched ${historicalData.length} days of data`);

    // Process and store prices
    let storedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const day of historicalData) {
      try {
        // chart() API returns quotes with { date, close, adjclose, ... }
        if (!day.date) {
          console.log(`   ⚠️  Skipping entry with no date`);
          errorCount++;
          continue;
        }

        const date = new Date(day.date);
        const dateStr = date.toISOString().split("T")[0];

        // Extract price - use adjclose if available, otherwise close
        const price = day.adjclose !== undefined ? day.adjclose : day.close;

        if (!price) {
          console.log(`   ⚠️  No price data for ${dateStr}`);
          errorCount++;
          continue;
        }

        // Check if data already exists
        const checkQuery = `
          SELECT COUNT(*) as count FROM daily_prices 
          WHERE date = ? AND token_symbol = 'AR' AND data_source = 'yahoo'
        `;
        const existing = await client.execute(checkQuery, [dateStr], {
          prepare: true,
        });

        if (existing.rows[0].count > 0) {
          if (!process.argv.includes("--overwrite")) {
            skippedCount++;
            continue;
          } else {
            // Delete existing
            await client.execute(
              "DELETE FROM daily_prices WHERE date = ? AND token_symbol = ? AND data_source = ?",
              [dateStr, "AR", "yahoo"],
              { prepare: true }
            );
          }
        }

        // Store price
        const storeTimestamp = Math.floor(Date.now() / 1000);
        const now = new Date();

        await client.execute(
          `INSERT INTO daily_prices (
            date, token_symbol, data_source, timestamp, price_usd,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [dateStr, "AR", "yahoo", storeTimestamp, price.toString(), now, now],
          { prepare: true }
        );

        storedCount++;
        if (storedCount % 10 === 0) {
          console.log(`   💾 Stored ${storedCount} prices...`);
        }
      } catch (error) {
        console.error(
          `   ❌ Error storing price for ${day.date}: ${error.message}`
        );
        errorCount++;
      }
    }

    console.log(`\n📊 Summary:`);
    console.log(`   ✅ Stored: ${storedCount} prices`);
    console.log(`   ⏭️  Skipped: ${skippedCount} (already exist)`);
    console.log(`   ❌ Errors: ${errorCount}`);

    console.log("\n✅ Historical AR prices import completed");
  } catch (error) {
    console.error("❌ Error importing AR prices:", error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    await client.shutdown();
    console.log("✅ Cassandra connection closed");
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
let startDate = null;
let endDate = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--start" && args[i + 1]) {
    startDate = args[++i];
  } else if (args[i] === "--end" && args[i + 1]) {
    endDate = args[++i];
  } else if (args[i] === "--help" || args[i] === "-h") {
    console.log(
      "Usage: node admin-utilities/import-historical-ar-prices.js [options]"
    );
    console.log("");
    console.log("Options:");
    console.log("  --start <date>    Start date (YYYY-MM-DD)");
    console.log("  --end <date>      End date (YYYY-MM-DD)");
    console.log("  --overwrite       Replace existing prices");
    console.log("  --help, -h        Show this help message");
    console.log("");
    console.log("Example:");
    console.log(
      "  node admin-utilities/import-historical-ar-prices.js --start 2024-06-01 --end 2024-08-31"
    );
    process.exit(0);
  }
}

if (!startDate || !endDate) {
  console.error("❌ Error: --start and --end dates are required");
  console.error("   Use --help for usage information");
  process.exit(1);
}

importHistoricalARPrices(startDate, endDate);
