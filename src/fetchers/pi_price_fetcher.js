#!/usr/bin/env node

/**
 * PI Price Fetcher
 *
 * Fetches PI prices from two sources:
 * 1. Permaswap GQL (OrderMade-Notice transactions) - August 1, 2025 to current
 * 2. Permaswap pool reserves (dryrun) - current price
 *
 * PI uses a different transaction structure than AO/ARIO:
 * - OrderMade-Notice transactions reference NoteID values
 * - CreateNote transactions contain the actual order data with prices
 */

const cassandra = require("cassandra-driver");
const https = require("https");
const { dryrun } = require("@permaweb/aoconnect");
const CONFIG = require("../../config/database");
const GraphQLClient = require("../utils/graphql-client");

class PIPriceFetcher {
  constructor() {
    this.client = null;
    this.poolProcessId = "zTLrDWJyH5Kf0L7BmTqYanGlww3SvHeRJdsf7Ph_HlA";
    this.piTokenId = "4hXj_E-5fAKmo4E8KjgQvuDJKAFk9P2grhycVmISDLs";
    this.wusdcTokenId = "7zH9dlMNoxprab9loshv3Y7WG45DOny_Vrq9KrXObdQ";
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

  async fetchOrderMadeNotices(startDate, endDate) {
    console.log(
      `   🔍 Querying GraphQL for PI OrderMade-Notice transactions...`
    );

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

    let allOrders = [];
    let hasNextPage = true;
    let cursor = null;
    let pageCount = 0;
    const pageSize = 100;

    while (hasNextPage) {
      pageCount++;

      const query = `
        query GetOrders($first: Int!, $after: String, $minBlock: Int!, $maxBlock: Int!) {
          transactions(
            first: $first
            after: $after
            block: { min: $minBlock, max: $maxBlock }
            tags: [
              { name: "From-Process", values: ["${this.poolProcessId}"] }
              { name: "Action", values: ["OrderMade-Notice"] }
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
      const orders = result.transactions.edges;

      allOrders = allOrders.concat(orders);
      hasNextPage = result.transactions.pageInfo.hasNextPage;
      if (orders.length > 0) {
        cursor = orders[orders.length - 1].cursor;
      }

      if (pageCount % 10 === 0) {
        console.log(
          `      ... ${pageCount} pages, ${allOrders.length} orders found`
        );
      }

      if (pageCount > 100) {
        console.log(`      ⚠️  Stopping at 100 pages to avoid rate limits`);
        break;
      }
    }

    console.log(
      `   ✅ Found ${allOrders.length} OrderMade-Notice transactions`
    );
    return allOrders;
  }

  async fetchCreateNoteTransaction(noteId) {
    const query = `
      query GetTransaction($id: ID!) {
        transaction(id: $id) {
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
    `;

    const variables = { id: noteId };
    const result = await this.queryArweaveGQL(query, variables);
    return result.transaction;
  }

  calculatePriceFromOrder(order) {
    const tags = {};
    order.tags.forEach((tag) => {
      tags[tag.name] = tag.value;
    });

    // Check if this is a PI/wUSDC order
    if (
      tags.HolderAssetID !== this.piTokenId ||
      tags.AssetID !== this.wusdcTokenId
    ) {
      return null;
    }

    const piAmount = parseFloat(tags.HolderAmount) / Math.pow(10, 12); // PI has 12 decimals
    const wusdcAmount = parseFloat(tags.Amount) / Math.pow(10, 6); // wUSDC has 6 decimals

    if (piAmount <= 0 || wusdcAmount <= 0) {
      return null;
    }

    // Price = wUSDC amount / PI amount
    const price = wusdcAmount / piAmount;
    return price;
  }

  async fetchPoolReserves() {
    try {
      console.log(`   🔍 Querying PI pool reserves...`);

      const result = await dryrun({
        process: this.poolProcessId,
        tags: [{ name: "Action", value: "Info" }],
      });

      if (!result.Messages || result.Messages.length === 0) {
        console.log(`   ⚠️  No response from PI pool`);
        return null;
      }

      const poolInfo = {};
      for (const tag of result.Messages[0].Tags) {
        poolInfo[tag.name] = tag.value;
      }

      const reserveX = BigInt(poolInfo.PX);
      const reserveY = BigInt(poolInfo.PY);

      // PI/wUSDC pool: Price = (reserveY / 10^6) / (reserveX / 10^12)
      const price =
        Number(reserveY) /
        Math.pow(10, 6) /
        (Number(reserveX) / Math.pow(10, 12));

      console.log(`   💰 PI pool price: $${price.toFixed(6)}`);
      return price;
    } catch (error) {
      console.error(`   ❌ Error querying PI pool:`, error.message);
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
      `\n📜 Fetching historical PI prices from OrderMade-Notice transactions...`
    );
    console.log(`📅 Date range: ${startDate} to ${endDate}`);

    const orders = await this.fetchOrderMadeNotices(startDate, endDate);

    if (orders.length === 0) {
      console.log(`   ⚠️  No PI orders found in date range`);
      return;
    }

    // Group orders by date
    const ordersByDate = {};

    for (const order of orders) {
      const timestamp = order.node.block.timestamp;
      const date = new Date(timestamp * 1000).toISOString().split("T")[0];

      if (date < startDate || date > endDate) {
        continue;
      }

      if (!ordersByDate[date]) {
        ordersByDate[date] = [];
      }
      ordersByDate[date].push(order);
    }

    console.log(
      `📊 Processing orders for ${Object.keys(ordersByDate).length} days...`
    );

    let processedCount = 0;
    let skippedCount = 0;

    for (const [date, dayOrders] of Object.entries(ordersByDate)) {
      console.log(`\n📅 Processing ${date} (${dayOrders.length} orders)...`);

      const prices = [];

      for (const order of dayOrders) {
        const tags = {};
        order.node.tags.forEach((tag) => {
          tags[tag.name] = tag.value;
        });

        const noteId = tags.NoteID;
        if (!noteId) {
          skippedCount++;
          continue;
        }

        try {
          const createNoteTx = await this.fetchCreateNoteTransaction(noteId);
          if (!createNoteTx) {
            skippedCount++;
            continue;
          }

          const price = this.calculatePriceFromOrder(createNoteTx);
          if (price && price > 0) {
            prices.push(price);
            console.log(`   💰 Order: $${price.toFixed(6)}`);
          } else {
            skippedCount++;
          }
        } catch (error) {
          console.log(`   ⚠️  Error processing order: ${error.message}`);
          skippedCount++;
        }
      }

      if (prices.length > 0) {
        const avgPrice = prices.reduce((sum, p) => sum + p, 0) / prices.length;
        console.log(
          `   📊 Average price for ${date}: $${avgPrice.toFixed(6)} (${
            prices.length
          } orders)`
        );
        await this.storePrice(date, "PI", avgPrice, "permaswap-pi-orders");
        processedCount++;
      } else {
        console.log(`   ⚠️  No valid prices found for ${date}`);
      }
    }

    console.log(`\n📊 Historical Summary:`);
    console.log(`   Processed: ${processedCount} days`);
    console.log(`   Skipped: ${skippedCount} orders`);
  }

  async fetchCurrentPrice() {
    console.log(`\n📊 Fetching current PI price from pool reserves...`);

    const price = await this.fetchPoolReserves();
    if (price && price > 0) {
      const today = new Date().toISOString().split("T")[0];
      await this.storePrice(today, "PI", price, "permaswap-AO");
      console.log(`   ✅ Current PI price stored: $${price.toFixed(6)}`);
    } else {
      console.log(`   ⚠️  Could not fetch current PI price`);
    }
  }

  async run() {
    const startDate = "2025-08-01";
    const endDate = new Date().toISOString().split("T")[0];

    console.log("🚀 Starting PI Price Fetcher");
    console.log(`📅 Date range: ${startDate} to ${endDate}`);

    try {
      await this.init();

      // Fetch historical prices from OrderMade-Notice transactions
      await this.fetchHistoricalPrices(startDate, endDate);

      // Fetch current price from pool reserves
      await this.fetchCurrentPrice();

      console.log("\n✅ PI price fetching completed");
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
  const fetcher = new PIPriceFetcher();

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

module.exports = PIPriceFetcher;
