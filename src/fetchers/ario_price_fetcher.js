#!/usr/bin/env node

/**
 * ARIO Price Fetcher
 *
 * Fetches ARIO prices from two sources:
 * 1. Permaswap GQL (Transfer transactions) - January 1, 2025 to current
 * 2. CoinGecko API - March 19, 2025 to current (with rate limiting)
 *
 * Skips CoinGecko calls if data already exists for that day.
 */

require("dotenv").config();
const cassandra = require("cassandra-driver");
const https = require("https");
const { dryrun } = require("@permaweb/aoconnect");
const CONFIG = require("../../config/database");
const GraphQLClient = require("../utils/graphql-client");

class ARIOPriceFetcher {
  constructor() {
    this.client = null;
    this.poolProcessId = "V7yzKBtzmY_MacDF-czrb1RY06xfidcGVrOjnhthMWM";
    this.coingeckoApiKey = process.env.COINGECKO_API_KEY;
    this.graphqlClient = new GraphQLClient({
      endpoints: [
        "https://arweave-search.goldsky.com/graphql",
        "https://arweave.net/graphql",
      ],
      maxRetries: 3,
      retryDelay: 2000,
      timeout: 45000,
    });
  }

  async init() {
    this.client = new cassandra.Client(CONFIG.PRICE_DB);
    await this.client.connect();
    console.log(`✅ Connected to Cassandra`);
  }

  async queryArweaveGQL(query, variables = null) {
    try {
      const result = await this.graphqlClient.execute(query, variables);
      return result.data;
    } catch (error) {
      console.error(`❌ GraphQL query failed: ${error.message}`);
      throw error;
    }
  }

  async fetchSwapTransactions(startDate, endDate) {
    console.log(`   🔍 Querying GraphQL for ARIO swap transactions...`);

    // Convert dates to block heights
    const BLOCKS_PER_DAY = 690;
    const KNOWN_BLOCK = 1606044;
    const KNOWN_TS = 1739116800; // Feb 9, 2025 00:00:00 UTC

    const startTs = Math.floor(new Date(startDate).getTime() / 1000);
    const endTs = Math.floor(new Date(endDate).getTime() / 1000);

    const daysSinceKnown = (startTs - KNOWN_TS) / (60 * 60 * 24);
    const minBlock =
      Math.floor(KNOWN_BLOCK + daysSinceKnown * BLOCKS_PER_DAY) - 1000;

    const daysToEnd = (endTs - KNOWN_TS) / (60 * 60 * 24);
    const maxBlock = Math.ceil(KNOWN_BLOCK + daysToEnd * BLOCKS_PER_DAY) + 1000;

    console.log(`      Block range: ${minBlock} to ${maxBlock}`);

    let allSwaps = [];
    let hasNextPage = true;
    let cursor = null;
    let pageCount = 0;
    const pageSize = 100;

    while (hasNextPage) {
      pageCount++;

      const query = `
        query GetSwaps($first: Int!, $after: String, $minBlock: Int!, $maxBlock: Int!) {
          transactions(
            first: $first
            after: $after
            block: { min: $minBlock, max: $maxBlock }
            tags: [
              { name: "From-Process", values: ["${this.poolProcessId}"] }
              { name: "Action", values: ["Transfer"] }
              { name: "X-PS-Status", values: ["Swapped"] }
            ]
            sort: HEIGHT_DESC
          ) {
            pageInfo {
              hasNextPage
            }
            edges {
              cursor
              node {
                id
                tags {
                  name
                  value
                }
                block {
                  timestamp
                  height
                }
              }
            }
          }
        }
      `;

      const variables = {
        first: pageSize,
        after: cursor,
        minBlock,
        maxBlock,
      };

      const result = await this.queryArweaveGQL(query, variables);
      const swaps = result.transactions.edges;

      allSwaps = allSwaps.concat(swaps);
      hasNextPage = result.transactions.pageInfo.hasNextPage;
      if (swaps.length > 0) {
        cursor = swaps[swaps.length - 1].cursor;
      }

      if (pageCount % 10 === 0) {
        console.log(
          `      ... ${pageCount} pages, ${allSwaps.length} swaps found`
        );
      }

      if (pageCount > 100) {
        console.log(`      ⚠️  Stopping at 100 pages to avoid rate limits`);
        break;
      }
    }

    console.log(`   ✅ Found ${allSwaps.length} swap transactions`);
    return allSwaps;
  }

  calculatePriceFromSwap(swap) {
    const tags = {};
    swap.node.tags.forEach((tag) => {
      tags[tag.name] = tag.value;
    });

    // Extract swap data - handle both old and new tag formats
    const tokenIn = tags["X-PS-TokenIn"];
    const tokenOut = tags["X-PS-TokenOut"];

    // Try new format first (X-PS-QuantityIn/Out), fall back to old format (X-PS-AmountIn/Quantity)
    let quantityIn = parseFloat(tags["X-PS-QuantityIn"] || "0");
    let quantityOut = parseFloat(tags["X-PS-QuantityOut"] || "0");

    if (quantityIn <= 0 || quantityOut <= 0) {
      // Fall back to old format
      quantityIn = parseFloat(tags["X-PS-AmountIn"] || "0");
      quantityOut = parseFloat(tags["Quantity"] || "0");
    }

    if (!tokenIn || quantityIn <= 0 || quantityOut <= 0) {
      return null;
    }

    // Calculate price based on swap direction
    let price = null;
    if (tokenIn === "qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE") {
      // ARIO -> wAR swap: Price of ARIO in wAR = AmountOut / AmountIn
      price = quantityOut / quantityIn;
    } else if (tokenIn === "xU9zFkq3X2ZQ6olwNVvr1vUWIjc3kXTWr7xKQD6dh10") {
      // wAR -> ARIO swap: Price of ARIO in wAR = AmountIn / AmountOut
      price = quantityIn / quantityOut;
    }

    return price;
  }

  async fetchCoinGeckoPrices(startDate, endDate) {
    console.log(`\n📜 Fetching ARIO prices from CoinGecko API...`);
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
        WHERE date = ? AND token_symbol = 'ARIO' AND data_source = 'coingecko'
      `;
      const existing = await this.client.execute(existingQuery, [date]);

      if (existing.rows[0].count > 0) {
        console.log(`   ⏭️  Skipping ${date} - data already exists`);
        skippedCount++;
        currentTs += 24 * 60 * 60; // Next day
        continue;
      }

      try {
        console.log(`   📅 Fetching data for ${date}...`);

        const url = `https://api.coingecko.com/api/v3/coins/ar-io-network/history?date=${date}&localization=false`;
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
                reject(new Error(`HTTP 429: Too Many Requests`));
              } else {
                reject(new Error(`HTTP ${res.statusCode}: ${body}`));
              }
            });
          });
          req.on("error", reject);
          req.end();
        });

        if (
          data.market_data &&
          data.market_data.current_price &&
          data.market_data.current_price.usd
        ) {
          const price = data.market_data.current_price.usd;
          await this.storePrice(date, "ARIO", price, "coingecko");
          console.log(`   💰 ${date}: $${price.toFixed(6)}`);
          fetchedCount++;
        } else {
          console.log(`   ⚠️  No price data for ${date}`);
        }

        // Rate limiting: wait 2.5 seconds between calls
        await new Promise((resolve) => setTimeout(resolve, 2500));
      } catch (error) {
        console.log(`   ⚠️  Error fetching data for ${date}: ${error.message}`);
      }

      currentTs += 24 * 60 * 60; // Next day
    }

    console.log(`\n📊 CoinGecko Summary:`);
    console.log(`   Fetched: ${fetchedCount} days`);
    console.log(`   Skipped: ${skippedCount} days (already exists)`);
  }

  async fetchPoolReserves() {
    try {
      console.log(`   🔍 Querying ARIO pool reserves...`);

      const result = await dryrun({
        process: this.poolProcessId,
        tags: [{ name: "Action", value: "Info" }],
      });

      if (!result.Messages || result.Messages.length === 0) {
        console.log(`   ⚠️  No response from ARIO pool`);
        return null;
      }

      const poolInfo = {};
      for (const tag of result.Messages[0].Tags) {
        poolInfo[tag.name] = tag.value;
      }

      const reserveX = BigInt(poolInfo.PX);
      const reserveY = BigInt(poolInfo.PY);

      // ARIO/wUSDC pool: Price = (reserveY / 10^6) / (reserveX / 10^12)
      const price =
        Number(reserveY) /
        Math.pow(10, 6) /
        (Number(reserveX) / Math.pow(10, 12));

      console.log(`   💰 ARIO pool price: $${price.toFixed(6)}`);
      return price;
    } catch (error) {
      console.error(`   ❌ Error querying ARIO pool:`, error.message);
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
      price.toString(),
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

  async fetchHistoricalPrices(startDate, endDate) {
    console.log(
      `\n📜 Fetching historical ARIO prices from swap transactions...`
    );
    console.log(`📅 Date range: ${startDate} to ${endDate}`);

    const swaps = await this.fetchSwapTransactions(startDate, endDate);

    if (swaps.length === 0) {
      console.log(`   ⚠️  No ARIO swaps found in date range`);
      return;
    }

    // Group swaps by date
    const swapsByDate = {};

    for (const swap of swaps) {
      const timestamp = swap.node.block.timestamp;
      const date = new Date(timestamp * 1000).toISOString().split("T")[0];

      if (date < startDate || date > endDate) {
        continue;
      }

      if (!swapsByDate[date]) {
        swapsByDate[date] = [];
      }
      swapsByDate[date].push(swap);
    }

    console.log(
      `📊 Processing swaps for ${Object.keys(swapsByDate).length} days...`
    );

    let processedCount = 0;
    let skippedCount = 0;

    for (const [date, daySwaps] of Object.entries(swapsByDate)) {
      console.log(`\n📅 Processing ${date} (${daySwaps.length} swaps)...`);

      const prices = [];

      for (const swap of daySwaps) {
        const price = this.calculatePriceFromSwap(swap);
        if (price && price > 0) {
          prices.push(price);
        } else {
          skippedCount++;
        }
      }

      if (prices.length > 0) {
        const avgPrice = prices.reduce((sum, p) => sum + p, 0) / prices.length;
        console.log(
          `   📊 Average price for ${date}: $${avgPrice.toFixed(6)} (${
            prices.length
          } swaps)`
        );
        await this.storePrice(date, "ARIO", avgPrice, "permaswap-GQL");
        processedCount++;
      } else {
        console.log(`   ⚠️  No valid prices found for ${date}`);
      }
    }

    console.log(`\n📊 Historical Summary:`);
    console.log(`   Processed: ${processedCount} days`);
    console.log(`   Skipped: ${skippedCount} swaps`);
  }

  async fetchCurrentPrice() {
    console.log(`\n📊 Fetching current ARIO price from pool reserves...`);

    const price = await this.fetchPoolReserves();
    if (price && price > 0) {
      const today = new Date().toISOString().split("T")[0];
      await this.storePrice(today, "ARIO", price, "permaswap-AO");
      console.log(`   ✅ Current ARIO price stored: $${price.toFixed(6)}`);
    } else {
      console.log(`   ⚠️  Could not fetch current ARIO price`);
    }
  }

  async run() {
    const startDate = "2025-01-01";
    const endDate = new Date().toISOString().split("T")[0];
    const coingeckoStartDate = "2025-03-19";

    console.log("🚀 Starting ARIO Price Fetcher");
    console.log(`📅 Date range: ${startDate} to ${endDate}`);

    try {
      await this.init();

      // Fetch historical prices from swap transactions
      await this.fetchHistoricalPrices(startDate, endDate);

      // Fetch CoinGecko prices (with rate limiting and skip existing)
      await this.fetchCoinGeckoPrices(coingeckoStartDate, endDate);

      // Fetch current price from pool reserves
      await this.fetchCurrentPrice();

      console.log("\n✅ ARIO price fetching completed");
    } catch (error) {
      console.error("❌ Error:", error);
      throw error;
    } finally {
      if (this.client) {
        await this.client.shutdown();
        console.log("✅ Cassandra connection closed");
      }
    }
  }

  async shutdown() {
    if (this.client) {
      await this.client.shutdown();
      console.log("✅ Cassandra connection closed");
    }
  }
}

async function main() {
  const fetcher = new ARIOPriceFetcher();

  try {
    await fetcher.run();
  } catch (error) {
    console.error("❌ Fatal error:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = ARIOPriceFetcher;
