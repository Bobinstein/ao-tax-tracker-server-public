#!/usr/bin/env node

const cassandra = require("cassandra-driver");
const https = require("https");
require("dotenv").config();

class ARPriceFetcher {
  constructor() {
    this.client = null;
    this.coingeckoApiKey = process.env.COINGECKO_API_KEY;
  }

  async init() {
    this.client = new cassandra.Client({
      contactPoints: ["localhost"],
      localDataCenter: "datacenter1",
      keyspace: "ao_price_data",
    });
    await this.client.connect();
    console.log("✅ Connected to Cassandra");
  }

  async fetchARCoinGeckoPrices(startDate, endDate) {
    console.log(`\n📜 Fetching AR prices from CoinGecko API...`);
    console.log(`📅 Date range: ${startDate} to ${endDate}`);

    const startTs = Math.floor(new Date(startDate).getTime() / 1000);
    const endTs = Math.floor(new Date(endDate).getTime() / 1000);

    let currentTs = startTs;
    let fetchedCount = 0;
    let skippedCount = 0;

    while (currentTs <= endTs) {
      const date = new Date(currentTs * 1000).toISOString().split("T")[0];

      // Check if data already exists
      const existingQuery = `
        SELECT COUNT(*) as count FROM daily_prices 
        WHERE date = ? AND token_symbol = 'AR' AND data_source = 'coingecko'
      `;
      const existing = await this.client.execute(existingQuery, [date]);

      if (existing.rows[0].count > 0) {
        console.log(`   ⏭️  Skipping ${date} - data already exists`);
        skippedCount++;
        currentTs += 24 * 60 * 60; // Next day
        continue;
      }

      try {
        console.log(`   📅 Fetching AR data for ${date}...`);

        const url = `https://api.coingecko.com/api/v3/coins/arweave/history?date=${date}&localization=false`;
        const options = {
          headers: {
            "x-cg-demo-api-key": this.coingeckoApiKey,
          },
        };

        const data = await new Promise((resolve, reject) => {
          const req = https.request(url, options, (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => {
              if (res.statusCode === 200) {
                try {
                  resolve(JSON.parse(body));
                } catch (error) {
                  reject(error);
                }
              } else if (res.statusCode === 429) {
                console.log(
                  `   ⚠️  Rate limited for ${date}, waiting 60 seconds...`
                );
                setTimeout(() => reject(new Error("Rate limited")), 60000);
              } else {
                reject(new Error(`HTTP ${res.statusCode}: ${body}`));
              }
            });
          });
          req.on("error", reject);
          req.end();
        });

        if (
          data &&
          data.market_data &&
          data.market_data.current_price &&
          data.market_data.current_price.usd
        ) {
          const price = data.market_data.current_price.usd;
          await this.storePrice(date, "AR", price, "coingecko");
          console.log(`   💰 AR: $${price.toFixed(6)} (${date})`);
          fetchedCount++;
        } else {
          console.log(`   ⚠️  No price data for AR on ${date}`);
        }

        // Rate limiting: wait 2.5 seconds between calls
        await new Promise((resolve) => setTimeout(resolve, 2500));
      } catch (error) {
        console.log(
          `   ⚠️  Error fetching AR data for ${date}: ${error.message}`
        );
      }

      currentTs += 24 * 60 * 60; // Next day
    }

    console.log(`\n📊 AR CoinGecko Summary:`);
    console.log(`   Fetched: ${fetchedCount} days`);
    console.log(`   Skipped: ${skippedCount} days (already exists)`);
  }

  async getHistoricalARPrice(date) {
    try {
      const query = `
        SELECT price_usd
        FROM daily_prices
        WHERE date = ? AND token_symbol = 'AR' AND data_source = 'coingecko'
        ALLOW FILTERING
      `;

      const result = await this.client.execute(query, [date]);

      if (result.rows.length > 0) {
        // Handle the price as a string to avoid BigDecimal issues
        const priceUsd = result.rows[0].price_usd;
        return parseFloat(priceUsd.toString());
      }

      return null;
    } catch (error) {
      console.error(
        `   ❌ Error fetching historical AR price for ${date}:`,
        error.message
      );
      return null;
    }
  }

  async storePrice(date, symbol, price, dataSource) {
    const timestamp = Math.floor(Date.now() / 1000);

    const query = `
      INSERT INTO daily_prices (
        date, token_symbol, data_source, timestamp, price_usd,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    const now = new Date();
    // Store price as string to avoid BigDecimal conversion issues
    const values = [
      date,
      symbol,
      dataSource,
      timestamp,
      price.toString(), // Store as string
      now,
      now,
    ];

    try {
      await this.client.execute(query, values);
      console.log(
        `   💾 Stored ${symbol}: $${price.toFixed(6)} (${date}) - ${dataSource}`
      );
    } catch (error) {
      console.error(`   ❌ Error storing ${symbol} price:`, error.message);
    }
  }

  async run() {
    const startDate = "2025-02-01"; // AR data available from early 2025
    const endDate = new Date().toISOString().split("T")[0];

    console.log("🚀 Starting AR Price Fetcher");
    console.log(`📅 Date range: ${startDate} to ${endDate}`);

    try {
      await this.init();

      // Fetch AR prices from CoinGecko
      await this.fetchARCoinGeckoPrices(startDate, endDate);

      console.log("\n✅ AR price fetching completed");
    } catch (error) {
      console.error("❌ AR price fetching failed:", error.message);
      throw error;
    } finally {
      if (this.client) {
        await this.client.shutdown();
      }
    }
  }

  async shutdown() {
    if (this.client) {
      await this.client.shutdown();
    }
  }
}

// Run if called directly
if (require.main === module) {
  const fetcher = new ARPriceFetcher();
  fetcher.run().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

module.exports = ARPriceFetcher;
