#!/usr/bin/env node

/**
 * AO Price Fetcher
 *
 * Fetches AO prices from two sources:
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

class AOPriceFetcher {
  constructor() {
    this.client = null;
    this.poolProcessId = "FRF1k0BSv0gRzNA2n-95_Fpz9gADq9BGi5PyXKFp6r8";
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
    console.log(`   🔍 Querying GraphQL for AO swap transactions...`);

    // Convert dates to block heights
    const BLOCKS_PER_DAY = 690;
    const KNOWN_BLOCK = 1606044;
    const KNOWN_TS = 1739116800; // Feb 9, 2025 00:00:00 UTC

    const startTs = Math.floor(new Date(startDate).getTime() / 1000);
    const endTs = Math.floor(new Date(endDate).getTime() / 1000);

    const daysSinceKnown = (startTs - KNOWN_TS) / (60 * 60 * 24);
    const minBlock =
      Math.floor(KNOWN_BLOCK + daysSinceKnown * BLOCKS_PER_DAY) - 100;

    const daysToEnd = (endTs - KNOWN_TS) / (60 * 60 * 24);
    const maxBlock = Math.ceil(KNOWN_BLOCK + daysToEnd * BLOCKS_PER_DAY) + 100;

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

      if (pageCount > 500) {
        console.log(`      ⚠️  Stopping at 500 pages to avoid rate limits`);
        break;
      }
    }

    console.log(`   ✅ Found ${allSwaps.length} swap transactions`);

    // Show date range of swaps found
    if (allSwaps.length > 0) {
      const dates = allSwaps
        .map((swap) => {
          const timestamp = swap.node.block.timestamp;
          return new Date(timestamp * 1000).toISOString().split("T")[0];
        })
        .sort();

      console.log(
        `   📅 Date range: ${dates[0]} to ${dates[dates.length - 1]}`
      );

      // Check if we have February data
      const februarySwaps = dates.filter((date) => date.startsWith("2025-02"));
      if (februarySwaps.length > 0) {
        console.log(`   🎯 Found ${februarySwaps.length} February swaps!`);
      } else {
        console.log(`   ⚠️  No February swaps found in this batch`);
      }
    }

    return allSwaps;
  }

  async calculatePriceFromSwap(swap, date) {
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
    let priceInWar = null;
    if (tokenIn === "0syT13r0s0tgPmIed95bJnuSqaD29HQNN8D3ElLSrsc") {
      // AO -> wAR swap: Price of AO in wAR = AmountOut / AmountIn
      priceInWar = quantityOut / quantityIn;
    } else if (tokenIn === "xU9zFkq3X2ZQ6olwNVvr1vUWIjc3kXTWr7xKQD6dh10") {
      // wAR -> AO swap: Price of AO in wAR = AmountIn / AmountOut
      priceInWar = quantityIn / quantityOut;
    }

    if (!priceInWar) {
      return null;
    }

    // Convert wAR price to USD using historical AR price (wAR ≈ AR)
    const arPrice = await this.getHistoricalARPrice(date);
    if (!arPrice) {
      console.log(`   ⚠️  Could not get historical AR price for ${date}`);
      return null;
    }

    const priceInUSD = priceInWar * arPrice;
    return priceInUSD;
  }

  async fetchCoinGeckoPrices(startDate, endDate) {
    console.log(`\n📜 Fetching AO prices from CoinGecko API...`);
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
        WHERE date = ? AND token_symbol = 'AO' AND data_source = 'coingecko'
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

        const url = `https://api.coingecko.com/api/v3/coins/ao-computer/history?date=${date}&localization=false`;
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
          await this.storePrice(date, "AO", price, "coingecko");
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
      console.log(`   🔍 Querying AO pool reserves...`);

      const result = await dryrun({
        process: this.poolProcessId,
        tags: [{ name: "Action", value: "Info" }],
      });

      if (!result.Messages || result.Messages.length === 0) {
        console.log(`   ⚠️  No response from AO pool`);
        return null;
      }

      const poolInfo = {};
      for (const tag of result.Messages[0].Tags) {
        poolInfo[tag.name] = tag.value;
      }

      const reserveX = BigInt(poolInfo.PX);
      const reserveY = BigInt(poolInfo.PY);

      // AO/wAR pool: Price = (reserveY / 10^12) / (reserveX / 10^12) * wAR_price
      // We need wAR price to convert to USD
      const wARPrice = await this.getWARPrice();
      if (!wARPrice) {
        console.log(`   ⚠️  Could not get wAR price for AO calculation`);
        return null;
      }

      const priceInWar =
        Number(reserveY) /
        Math.pow(10, 12) /
        (Number(reserveX) / Math.pow(10, 12));
      const price = priceInWar * wARPrice;

      console.log(`   💰 AO pool price: $${price.toFixed(6)}`);
      return price;
    } catch (error) {
      console.error(`   ❌ Error querying AO pool:`, error.message);
      return null;
    }
  }

  async getWARPrice() {
    try {
      const url = "https://api-ffpscan.permaswap.network/tokenList";
      const data = await new Promise((resolve, reject) => {
        const req = https.request(url, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(body));
            } catch (error) {
              reject(error);
            }
          });
        });
        req.on("error", reject);
        req.end();
      });

      const warToken = data.find((t) => t.symbol === "wAR");
      return warToken ? parseFloat(warToken.price) : null;
    } catch (error) {
      console.error(`   ❌ Error fetching wAR price:`, error.message);
      return null;
    }
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

  async fetchHistoricalPrices(startDate, endDate) {
    console.log(`\n📜 Fetching historical AO prices from swap transactions...`);
    console.log(`📅 Date range: ${startDate} to ${endDate}`);

    const swaps = await this.fetchSwapTransactions(startDate, endDate);

    if (swaps.length === 0) {
      console.log(`   ⚠️  No AO swaps found in date range`);
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
        const price = await this.calculatePriceFromSwap(swap, date);
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
        await this.storePrice(date, "AO", avgPrice, "permaswap-GQL");
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
    console.log(`\n📊 Fetching current AO price from pool reserves...`);

    const price = await this.fetchPoolReserves();
    if (price && price > 0) {
      const today = new Date().toISOString().split("T")[0];
      await this.storePrice(today, "AO", price, "permaswap-AO");
      console.log(`   ✅ Current AO price stored: $${price.toFixed(6)}`);
    } else {
      console.log(`   ⚠️  Could not fetch current AO price`);
    }
  }

  async run() {
    const startDate = "2025-02-01"; // AO data available from Feb 1, 2025
    const endDate = new Date().toISOString().split("T")[0];
    const coingeckoStartDate = "2025-03-19";

    console.log("🚀 Starting AO Price Fetcher");
    console.log(`📅 Date range: ${startDate} to ${endDate}`);

    try {
      await this.init();

      // Note: AR prices should be fetched separately using ar_price_fetcher.js
      // This ensures proper storage and avoids BigDecimal issues

      // Fetch historical prices from swap transactions (now with correct AR conversion)
      await this.fetchHistoricalPrices(startDate, endDate);

      // Fetch CoinGecko prices (with rate limiting and skip existing)
      await this.fetchCoinGeckoPrices(coingeckoStartDate, endDate);

      // Fetch current price from pool reserves
      await this.fetchCurrentPrice();

      console.log("\n✅ AO price fetching completed");
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
  const fetcher = new AOPriceFetcher();

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

module.exports = AOPriceFetcher;
