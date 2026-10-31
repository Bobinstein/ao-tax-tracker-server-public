#!/usr/bin/env node

const path = require("path");
const fs = require("fs");
const cassandra = require("cassandra-driver");
const { jsPDF } = require("jspdf");
const { ARIO } = require("@ar.io/sdk");
const CONFIG = require("../../config/database");
const {
  FiatConversionService,
} = require("./ar-tracker/FiatConversionService");

// Token symbol to process ID mapping for DEX lookups
const TOKEN_PROCESS_IDS = {
  PIXL: "DM3FoZUq_yebASPhgd8pEIRIzDW6muXEhxz5-JwbZwo",
  wAR: "xU9zFkq3X2ZQ6olwNVvr1vUWIjc3kXTWr7xKQD6dh10",
  wUSDC: "7zH9dlMNoxprab9loshv3Y7WG45DOny_Vrq9KrXObdQ",
  AO: "0syT13r0s0tgPmIed95bJnuSqaD29HQNN8D3ElLSrsc",
  USDA: "FBt9A5GA_KXMMSxA2DJ0xZbAq8sLLU2ak-YJe9zDvg8",
  ARIO: "qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE",
  PI: "4hXj_E-5fAKmo4E8KjgQvuDJKAFk9P2grhycVmISDLs",
};

// Token decimal places for proper price conversion
const TOKEN_DECIMALS = {
  PIXL: 6,
  wAR: 12,
  wUSDC: 6,
  AO: 12,
  USDA: 6,
  ARIO: 6,
  PI: 12,
  AR: 12, // Native AR
};

// Currency display (match TaxReportGenerator; values in report remain USD until conversion added)
const CURRENCY_SYMBOLS = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  AUD: "A$",
  CAD: "C$",
  CHF: "Fr.",
  CNY: "¥",
  INR: "₹",
  KRW: "₩",
  BRL: "R$",
  MXN: "MX$",
  SGD: "S$",
  HKD: "HK$",
  NZD: "NZ$",
  SEK: "kr.",
  NOK: "kr.",
  DKK: "kr.",
};

class WalletDistributionPDFGenerator {
  getCurrencySymbol(currency) {
    return (
      CURRENCY_SYMBOLS[currency?.toUpperCase()] ||
      (currency ? `${currency} ` : "$")
    );
  }

  constructor() {
    this.priceClient = null;
    this.distributionClient = null;
    this.piDistributionClient = null;
    this.arioDistributionClient = null;
    this.pixlDistributionClient = null;
    this.dexPriceClient = null;
    this.gatewayClient = null;
    this.priceCache = new Map();
    this.corruptedEpochs = [];
  }

  async init() {
    console.log("🔌 Initializing PDF Generator...");

    // Initialize price database connection
    this.priceClient = new cassandra.Client(CONFIG.PRICE_DB);
    await this.priceClient.connect();
    console.log("✅ Connected to price database");

    // Initialize distribution database connection
    this.distributionClient = new cassandra.Client(CONFIG.AO_DISTRIBUTION_DB);
    await this.distributionClient.connect();
    console.log("✅ Connected to AO distribution database");

    // Initialize PI distribution database connection
    this.piDistributionClient = new cassandra.Client(CONFIG.PI_DISTRIBUTION_DB);
    await this.piDistributionClient.connect();
    console.log("✅ Connected to PI distribution database");

    // Initialize ARIO distribution database connection
    this.arioDistributionClient = new cassandra.Client(
      CONFIG.ARIO_DISTRIBUTION_DB,
    );
    await this.arioDistributionClient.connect();
    console.log("✅ Connected to ARIO distribution database");

    // Initialize PIXL distribution database connection (uses ar_tax_tracker keyspace)
    this.pixlDistributionClient = new cassandra.Client(
      CONFIG.AR_TAX_TRACKER_DB,
    );
    await this.pixlDistributionClient.connect();
    console.log("✅ Connected to PIXL distribution database");

    // Initialize DEX price client (for tokens without CoinGecko listings)
    this.dexPriceClient = new cassandra.Client({
      contactPoints: ["localhost"],
      localDataCenter: "datacenter1",
      keyspace: "ao_price_data",
    });
    await this.dexPriceClient.connect();
    console.log("✅ Connected to DEX price database");

    // Initialize gateway client for hybrid state queries
    this.gatewayClient = new cassandra.Client({
      contactPoints: ["127.0.0.1"],
      localDataCenter: "datacenter1",
      keyspace: "ario_distributions",
    });
    await this.gatewayClient.connect();
    console.log("✅ Connected to gateway state database");

    // Load corrupted epoch information
    await this.loadCorruptedEpochs();

    console.log("✅ PDF Generator initialized");
  }

  async loadCorruptedEpochs() {
    try {
      const result = await this.arioDistributionClient.execute(
        "SELECT epoch_index, note FROM ario_epochs_processed WHERE is_corrupted = true ALLOW FILTERING",
      );

      this.corruptedEpochs = result.rows.map((row) => ({
        epochIndex: parseInt(row.epoch_index.toString()),
        note: row.note,
      }));

      if (this.corruptedEpochs.length > 0) {
        console.log(
          `⚠️  Found ${
            this.corruptedEpochs.length
          } corrupted epochs: ${this.corruptedEpochs
            .map((e) => e.epochIndex)
            .join(", ")}`,
        );
      }
    } catch (error) {
      console.log(
        `⚠️  Could not load corrupted epoch metadata: ${error.message}`,
      );
      this.corruptedEpochs = [];
    }
  }

  // Get token decimal places
  getTokenDecimals(tokenSymbol) {
    return TOKEN_DECIMALS[tokenSymbol] || 12; // Default to 12 if unknown
  }

  // Get price data with CoinGecko priority
  async getPriceData(tokenSymbol, date) {
    const cacheKey = `${tokenSymbol}-${date}`;
    if (this.priceCache.has(cacheKey)) {
      return this.priceCache.get(cacheKey);
    }

    try {
      // First try CoinGecko
      const coingeckoQuery = `
        SELECT price_usd, data_source
        FROM daily_prices
        WHERE date = ? AND token_symbol = ? AND data_source = ?
        ALLOW FILTERING
      `;

      const coingeckoResult = await this.priceClient.execute(coingeckoQuery, [
        date,
        tokenSymbol,
        "coingecko",
      ]);

      if (coingeckoResult.rows.length > 0) {
        try {
          const priceUsd = coingeckoResult.rows[0].price_usd;
          let price;

          // Handle BigDecimal values directly
          if (priceUsd.constructor.name === "BigDecimal") {
            // Try to get the value directly from BigDecimal
            try {
              price = parseFloat(priceUsd.toString());
            } catch (e) {
              // If toString fails, try to reconstruct from the internal representation
              const intVal = priceUsd._intVal;
              let scale = priceUsd._scale;

              // If scale is corrupted (too large), use a reasonable default
              if (scale > 1000 || scale < -1000) {
                console.log(
                  `⚠️  Corrupted scale detected: ${scale}, using default scale of 6`,
                );
                scale = 6;

                // If both scale and intVal are corrupted, try to extract a reasonable price
                // by using the intVal as a raw number and applying the default scale
                if (intVal && typeof intVal.toString === "function") {
                  const intStr = intVal.toString();
                  // For corrupted data, try to extract a reasonable price
                  // by treating the intVal as if it were already properly scaled
                  if (intStr.length > 0) {
                    // Try to extract a reasonable price by dividing by 10^6 (assuming 6 decimal places)
                    const rawPrice = parseInt(intStr) / Math.pow(10, 6);
                    if (rawPrice > 0 && rawPrice < 10000) {
                      // Reasonable price range
                      price = rawPrice;
                      console.log(
                        `⚠️  Using reconstructed price: ${price} from corrupted BigDecimal`,
                      );
                    }
                  }
                }
              }

              if (intVal && typeof intVal.toString === "function") {
                const intStr = intVal.toString();
                // Handle negative scale (which indicates the number is very large)
                if (scale < 0) {
                  // For negative scale, we need to add zeros
                  const zeros = "0".repeat(Math.abs(scale));
                  const decimalStr = intStr + zeros;
                  price = parseFloat(decimalStr);
                } else {
                  // For positive scale, insert decimal point
                  if (intStr.length <= scale) {
                    // If the integer part is shorter than scale, pad with zeros
                    const paddedStr =
                      "0".repeat(scale - intStr.length + 1) + intStr;
                    const decimalStr =
                      paddedStr.slice(0, -scale) +
                      "." +
                      paddedStr.slice(-scale);
                    price = parseFloat(decimalStr);
                  } else {
                    const decimalStr =
                      intStr.slice(0, -scale) + "." + intStr.slice(-scale);
                    price = parseFloat(decimalStr);
                  }
                }
              } else {
                throw new Error("Cannot parse BigDecimal value");
              }
            }
          } else {
            // Handle string or number values (new format)
            price = parseFloat(priceUsd.toString());
          }

          this.priceCache.set(cacheKey, { price, source: "coingecko" });
          return { price, source: "coingecko" };
        } catch (error) {
          console.log(
            `⚠️  Error parsing CoinGecko price for ${tokenSymbol} on ${date}: ${error.message}`,
          );
        }
      }

      // Second priority: Permaswap-AO (direct from pool reserves)
      const permaswapAOQuery = `
        SELECT price_usd, data_source
        FROM daily_prices
        WHERE date = ? AND token_symbol = ? AND data_source = ?
        ALLOW FILTERING
      `;

      const permaswapAOResult = await this.priceClient.execute(
        permaswapAOQuery,
        [date, tokenSymbol, "permaswap-AO"],
      );

      if (permaswapAOResult.rows.length > 0) {
        try {
          const priceUsd = permaswapAOResult.rows[0].price_usd;
          let price;

          // Handle BigDecimal values directly
          if (priceUsd.constructor.name === "BigDecimal") {
            // Try to get the value directly from BigDecimal
            try {
              price = parseFloat(priceUsd.toString());
            } catch (e) {
              // If toString fails, try to reconstruct from the internal representation
              const intVal = priceUsd._intVal;
              let scale = priceUsd._scale;

              // If scale is corrupted (too large), use a reasonable default
              if (scale > 1000 || scale < -1000) {
                console.log(
                  `⚠️  Corrupted scale detected: ${scale}, using default scale of 6`,
                );
                scale = 6;

                // If both scale and intVal are corrupted, try to extract a reasonable price
                // by using the intVal as a raw number and applying the default scale
                if (intVal && typeof intVal.toString === "function") {
                  const intStr = intVal.toString();
                  // For corrupted data, try to extract a reasonable price
                  // by treating the intVal as if it were already properly scaled
                  if (intStr.length > 0) {
                    // Try to extract a reasonable price by dividing by 10^6 (assuming 6 decimal places)
                    const rawPrice = parseInt(intStr) / Math.pow(10, 6);
                    if (rawPrice > 0 && rawPrice < 10000) {
                      // Reasonable price range
                      price = rawPrice;
                      console.log(
                        `⚠️  Using reconstructed price: ${price} from corrupted BigDecimal`,
                      );
                    }
                  }
                }
              }

              if (intVal && typeof intVal.toString === "function") {
                const intStr = intVal.toString();
                // Handle negative scale (which indicates the number is very large)
                if (scale < 0) {
                  // For negative scale, we need to add zeros
                  const zeros = "0".repeat(Math.abs(scale));
                  const decimalStr = intStr + zeros;
                  price = parseFloat(decimalStr);
                } else {
                  // For positive scale, insert decimal point
                  if (intStr.length <= scale) {
                    // If the integer part is shorter than scale, pad with zeros
                    const paddedStr =
                      "0".repeat(scale - intStr.length + 1) + intStr;
                    const decimalStr =
                      paddedStr.slice(0, -scale) +
                      "." +
                      paddedStr.slice(-scale);
                    price = parseFloat(decimalStr);
                  } else {
                    const decimalStr =
                      intStr.slice(0, -scale) + "." + intStr.slice(-scale);
                    price = parseFloat(decimalStr);
                  }
                }
              } else {
                throw new Error("Cannot parse BigDecimal value");
              }
            }
          } else {
            // Handle string or number values (new format)
            price = parseFloat(priceUsd.toString());
          }

          this.priceCache.set(cacheKey, { price, source: "permaswap-AO" });
          return { price, source: "permaswap-AO" };
        } catch (error) {
          console.log(
            `⚠️  Error parsing Permaswap-AO price for ${tokenSymbol} on ${date}: ${error.message}`,
          );
        }
      }

      // Third priority: Permaswap-GQL (from historical swap transactions)
      const permaswapGQLQuery = `
        SELECT price_usd, data_source
        FROM daily_prices
        WHERE date = ? AND token_symbol = ? AND data_source = ?
        ALLOW FILTERING
      `;

      const permaswapGQLResult = await this.priceClient.execute(
        permaswapGQLQuery,
        [date, tokenSymbol, "permaswap-GQL"],
      );

      if (permaswapGQLResult.rows.length > 0) {
        try {
          const priceUsd = permaswapGQLResult.rows[0].price_usd;
          let price;

          // Handle BigDecimal values directly
          if (priceUsd.constructor.name === "BigDecimal") {
            // Try to get the value directly from BigDecimal
            try {
              price = parseFloat(priceUsd.toString());
            } catch (e) {
              // If toString fails, try to reconstruct from the internal representation
              const intVal = priceUsd._intVal;
              let scale = priceUsd._scale;

              // If scale is corrupted (too large), use a reasonable default
              if (scale > 1000 || scale < -1000) {
                console.log(
                  `⚠️  Corrupted scale detected: ${scale}, using default scale of 6`,
                );
                scale = 6;

                // If both scale and intVal are corrupted, try to extract a reasonable price
                // by using the intVal as a raw number and applying the default scale
                if (intVal && typeof intVal.toString === "function") {
                  const intStr = intVal.toString();
                  // For corrupted data, try to extract a reasonable price
                  // by treating the intVal as if it were already properly scaled
                  if (intStr.length > 0) {
                    // Try to extract a reasonable price by dividing by 10^6 (assuming 6 decimal places)
                    const rawPrice = parseInt(intStr) / Math.pow(10, 6);
                    if (rawPrice > 0 && rawPrice < 10000) {
                      // Reasonable price range
                      price = rawPrice;
                      console.log(
                        `⚠️  Using reconstructed price: ${price} from corrupted BigDecimal`,
                      );
                    }
                  }
                }
              }

              if (intVal && typeof intVal.toString === "function") {
                const intStr = intVal.toString();
                // Handle negative scale (which indicates the number is very large)
                if (scale < 0) {
                  // For negative scale, we need to add zeros
                  const zeros = "0".repeat(Math.abs(scale));
                  const decimalStr = intStr + zeros;
                  price = parseFloat(decimalStr);
                } else {
                  // For positive scale, insert decimal point
                  if (intStr.length <= scale) {
                    // If the integer part is shorter than scale, pad with zeros
                    const paddedStr =
                      "0".repeat(scale - intStr.length + 1) + intStr;
                    const decimalStr =
                      paddedStr.slice(0, -scale) +
                      "." +
                      paddedStr.slice(-scale);
                    price = parseFloat(decimalStr);
                  } else {
                    const decimalStr =
                      intStr.slice(0, -scale) + "." + intStr.slice(-scale);
                    price = parseFloat(decimalStr);
                  }
                }
              } else {
                throw new Error("Cannot parse BigDecimal value");
              }
            }
          } else {
            // Handle string or number values (new format)
            price = parseFloat(priceUsd.toString());
          }

          this.priceCache.set(cacheKey, { price, source: "permaswap-GQL" });
          return { price, source: "permaswap-GQL" };
        } catch (error) {
          console.log(
            `⚠️  Error parsing Permaswap-GQL price for ${tokenSymbol} on ${date}: ${error.message}`,
          );
        }
      }

      // Fallback: Old permaswap source (if any exists)
      const permaswapLegacyResult = await this.priceClient.execute(
        permaswapAOQuery,
        [date, tokenSymbol, "permaswap"],
      );

      if (permaswapLegacyResult.rows.length > 0) {
        try {
          const price = parseFloat(
            permaswapLegacyResult.rows[0].price_usd.toString(),
          );
          this.priceCache.set(cacheKey, { price, source: "permaswap" });
          return { price, source: "permaswap" };
        } catch (error) {
          console.log(
            `⚠️  Error parsing Permaswap legacy price for ${tokenSymbol} on ${date}: ${error.message}`,
          );
        }
      }

      // No price data found for this exact date
      // Try forward-fill: look for the most recent prior price
      const forwardFillPrice = await this.getForwardFillPrice(
        tokenSymbol,
        date,
      );
      if (forwardFillPrice) {
        this.priceCache.set(cacheKey, forwardFillPrice);
        return forwardFillPrice;
      }

      // Try DEX price index (for tokens like PIXL that aren't on CoinGecko)
      const dexPrice = await this.getDexPrice(tokenSymbol, date);
      if (dexPrice) {
        this.priceCache.set(cacheKey, dexPrice);
        return dexPrice;
      }

      // Still no price data found
      this.priceCache.set(cacheKey, { price: null, source: null });
      return { price: null, source: null };
    } catch (error) {
      console.log(
        `⚠️  Error fetching price for ${tokenSymbol} on ${date}: ${error.message}`,
      );
      this.priceCache.set(cacheKey, { price: null, source: null });
      return { price: null, source: null };
    }
  }

  async getForwardFillPrice(tokenSymbol, date) {
    try {
      // Get the most recent price before this date
      // Query all sources and take the most recent one
      const query = `
        SELECT date, price_usd, data_source
        FROM daily_prices
        WHERE token_symbol = ? AND date < ?
        ALLOW FILTERING
      `;

      const result = await this.priceClient.execute(query, [tokenSymbol, date]);

      if (result.rows.length > 0) {
        // Sort by date descending to get most recent
        const sortedRows = result.rows.sort((a, b) => {
          return b.date.localeCompare(a.date);
        });

        const mostRecent = sortedRows[0];
        try {
          const priceUsd = mostRecent.price_usd;
          let price;

          // Handle BigDecimal values directly
          if (priceUsd.constructor.name === "BigDecimal") {
            // Try to get the value directly from BigDecimal
            try {
              price = parseFloat(priceUsd.toString());
            } catch (e) {
              // If toString fails, try to reconstruct from the internal representation
              const intVal = priceUsd._intVal;
              let scale = priceUsd._scale;

              // If scale is corrupted (too large), use a reasonable default
              if (scale > 1000 || scale < -1000) {
                console.log(
                  `⚠️  Corrupted scale detected: ${scale}, using default scale of 6`,
                );
                scale = 6;

                // If both scale and intVal are corrupted, try to extract a reasonable price
                // by using the intVal as a raw number and applying the default scale
                if (intVal && typeof intVal.toString === "function") {
                  const intStr = intVal.toString();
                  // For corrupted data, try to extract a reasonable price
                  // by treating the intVal as if it were already properly scaled
                  if (intStr.length > 0) {
                    // Try to extract a reasonable price by dividing by 10^6 (assuming 6 decimal places)
                    const rawPrice = parseInt(intStr) / Math.pow(10, 6);
                    if (rawPrice > 0 && rawPrice < 10000) {
                      // Reasonable price range
                      price = rawPrice;
                      console.log(
                        `⚠️  Using reconstructed price: ${price} from corrupted BigDecimal`,
                      );
                    }
                  }
                }
              }

              if (intVal && typeof intVal.toString === "function") {
                const intStr = intVal.toString();
                // Handle negative scale (which indicates the number is very large)
                if (scale < 0) {
                  // For negative scale, we need to add zeros
                  const zeros = "0".repeat(Math.abs(scale));
                  const decimalStr = intStr + zeros;
                  price = parseFloat(decimalStr);
                } else {
                  // For positive scale, insert decimal point
                  if (intStr.length <= scale) {
                    // If the integer part is shorter than scale, pad with zeros
                    const paddedStr =
                      "0".repeat(scale - intStr.length + 1) + intStr;
                    const decimalStr =
                      paddedStr.slice(0, -scale) +
                      "." +
                      paddedStr.slice(-scale);
                    price = parseFloat(decimalStr);
                  } else {
                    const decimalStr =
                      intStr.slice(0, -scale) + "." + intStr.slice(-scale);
                    price = parseFloat(decimalStr);
                  }
                }
              } else {
                throw new Error("Cannot parse BigDecimal value");
              }
            }
          } else {
            // Handle string or number values (new format)
            price = parseFloat(priceUsd.toString());
          }

          return {
            price,
            source: `${mostRecent.data_source} (forward-filled from ${mostRecent.date})`,
          };
        } catch (error) {
          console.log(
            `⚠️  Error parsing forward-fill price for ${tokenSymbol}: ${error.message}`,
          );
          return null;
        }
      }

      return null;
    } catch (error) {
      console.log(
        `⚠️  Error in forward-fill for ${tokenSymbol}: ${error.message}`,
      );
      return null;
    }
  }

  // Get DEX price with wAR->USD conversion
  async getDexPrice(tokenSymbol, date) {
    const processId = TOKEN_PROCESS_IDS[tokenSymbol];
    if (!processId) {
      return null;
    }

    try {
      // Query dex_token_prices for exact date or forward-fill
      const exactQuery = `
        SELECT price_in_war, price_in_usdc, price_usd, source_platform, price_date
        FROM dex_token_prices
        WHERE token_process_id = ? AND price_date = ?
        ORDER BY block_timestamp DESC
        LIMIT 1
      `;

      let result = await this.dexPriceClient.execute(exactQuery, [
        processId,
        date,
      ]);

      // If no exact match, try forward-fill
      if (result.rows.length === 0) {
        const forwardFillQuery = `
          SELECT price_in_war, price_in_usdc, price_usd, source_platform, price_date
          FROM dex_token_prices
          WHERE token_process_id = ? AND price_date < ?
          ORDER BY price_date DESC, block_timestamp DESC
          LIMIT 1
          ALLOW FILTERING
        `;
        result = await this.dexPriceClient.execute(forwardFillQuery, [
          processId,
          date,
        ]);
      }

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      let priceUSD = null;
      let source = row.source_platform || "dex";
      const isForwardFilled = row.price_date !== date;

      // If already has USD price, use it
      if (row.price_usd) {
        priceUSD = parseFloat(row.price_usd.toString());
      }

      // If has USDC price, use that (1 USDC = $1)
      if (!priceUSD && row.price_in_usdc) {
        priceUSD = parseFloat(row.price_in_usdc.toString());
      }

      // If has wAR price, convert via AR price
      if (!priceUSD && row.price_in_war) {
        const rawPriceInWar = parseFloat(row.price_in_war.toString());
        if (rawPriceInWar > 0) {
          // price_in_war is stored as BASE UNIT RATIO (wAR_base / token_base)
          // To convert to human-readable wAR per token:
          // Divide by 10^(wAR_decimals - token_decimals)
          // wAR has 12 decimals, most tokens have 6-12 decimals
          // For PIXL (6 decimals): divide by 10^(12-6) = 10^6
          // This converts e.g., 130.846 base ratio → 0.000131 wAR per PIXL
          const tokenDecimals = this.getTokenDecimals(tokenSymbol);
          const wARDecimals = 12;
          const decimalAdjustment = Math.pow(10, wARDecimals - tokenDecimals);
          const priceInWar = rawPriceInWar / decimalAdjustment;

          // Sanity check at wAR level: no legitimate token should be worth > 10 wAR (~$70)
          // Bazar has erroneous data where price_in_war values are garbage (e.g., 698M)
          if (priceInWar <= 10) {
            // Get AR price for conversion (use the distribution date for AR price)
            const arPrice = await this.getPriceData("AR", date);
            if (arPrice.price) {
              priceUSD = priceInWar * arPrice.price;
              source = `${source} (via AR)`;
            }
          }
        }
      }

      if (priceUSD && priceUSD > 0) {
        const ffNote = isForwardFilled
          ? ` (forward-filled from ${row.price_date})`
          : "";
        return {
          price: priceUSD,
          source: `${source}${ffNote}`,
        };
      }

      return null;
    } catch (error) {
      // Silently handle DEX price lookup errors - fall back to daily_prices
      return null;
    }
  }

  // Get wallet distributions
  async getWalletDistributions(walletAddress, startDate, endDate) {
    console.log(`🔍 Fetching distributions for wallet: ${walletAddress}`);
    console.log(`📅 Date range: ${startDate} to ${endDate}`);

    const query = `
      SELECT txid, address, ao_amount_units, amount_units, date, full_date, from_process, target_process
      FROM distributions
      WHERE address = ? AND date >= ? AND date <= ?
      ALLOW FILTERING
    `;

    const result = await this.distributionClient.execute(query, [
      walletAddress,
      startDate,
      endDate,
    ]);

    console.log(`✅ Found ${result.rows.length} distributions`);

    // Process distributions
    const distributions = [];
    for (const row of result.rows) {
      const distributionDate = row.date;

      // Parse AO amount (ao_amount_units is the primary amount)
      let aoAmount = 0;
      if (row.ao_amount_units && row.ao_amount_units !== "0") {
        aoAmount =
          parseFloat(row.ao_amount_units) /
          Math.pow(10, CONFIG.TOKENS.AO.decimals);
      }

      distributions.push({
        txid: row.txid,
        date: distributionDate,
        aoAmount: aoAmount,
        sourceProcess: row.from_process,
        targetProcess: row.target_process,
      });
    }

    // Sort by date
    distributions.sort((a, b) => new Date(a.date) - new Date(b.date));

    return distributions;
  }

  // Get PI distributions for a wallet within date range
  async getPIWalletDistributions(walletAddress, startDate, endDate) {
    console.log(`🔍 Fetching PI distributions for wallet: ${walletAddress}`);
    console.log(`📅 Date range: ${startDate} to ${endDate}`);

    const query = `
      SELECT txid, address, pi_amount_units, date, full_date, from_process, target_process
      FROM distributions
      WHERE address = ? AND date >= ? AND date <= ?
      ALLOW FILTERING
    `;

    const result = await this.piDistributionClient.execute(query, [
      walletAddress,
      startDate,
      endDate,
    ]);

    console.log(`✅ Found ${result.rows.length} PI distributions`);

    // Process distributions
    const distributions = [];
    for (const row of result.rows) {
      const distributionDate = row.date;

      // Parse PI amount
      let piAmount = 0;
      if (row.pi_amount_units && row.pi_amount_units !== "0") {
        piAmount =
          parseFloat(row.pi_amount_units) /
          Math.pow(10, CONFIG.TOKENS.PI.decimals);
      }

      distributions.push({
        txid: row.txid,
        date: distributionDate,
        piAmount: piAmount,
        sourceProcess: row.from_process,
        targetProcess: row.target_process,
      });
    }

    // Sort by date
    distributions.sort((a, b) => new Date(a.date) - new Date(b.date));

    return distributions;
  }

  // Get PIXL distributions for a wallet within date range
  async getPIXLWalletDistributions(walletAddress, startDate, endDate) {
    console.log(`🔍 Fetching PIXL distributions for wallet: ${walletAddress}`);
    console.log(`📅 Date range: ${startDate} to ${endDate}`);

    const query = `
      SELECT wallet_address, distribution_block, distribution_timestamp, 
             run_rewards_tx_id, amount_units, amount_human, streak_days, 
             streak_multiplier, verified
      FROM pixl_distributions
      WHERE wallet_address = ?
      ALLOW FILTERING
    `;

    const result = await this.pixlDistributionClient.execute(query, [
      walletAddress,
    ]);

    // Filter by date range and process distributions
    const distributions = [];
    for (const row of result.rows) {
      const distributionDate = new Date(row.distribution_timestamp);
      const dateStr = distributionDate.toISOString().split("T")[0];

      // Filter by date range
      if (dateStr < startDate || dateStr > endDate) {
        continue;
      }

      // Parse PIXL amount - stored as TEXT for exact precision
      let pixlAmount = 0;
      if (row.amount_units && row.amount_units !== "0") {
        // PIXL has 6 decimals
        pixlAmount = parseFloat(row.amount_units) / Math.pow(10, 6);
      }

      distributions.push({
        txid: row.run_rewards_tx_id,
        date: dateStr,
        pixlAmount: pixlAmount,
        pixlAmountUnits: row.amount_units,
        streakDays: row.streak_days,
        streakMultiplier: parseFloat(row.streak_multiplier || 0),
        blockHeight: row.distribution_block,
        verified: row.verified,
      });
    }

    console.log(`✅ Found ${distributions.length} PIXL distributions`);

    // Sort by date
    distributions.sort((a, b) => new Date(a.date) - new Date(b.date));

    return distributions;
  }

  // Get ARIO distributions for a wallet within date range
  async getARIOWalletDistributions(
    walletAddress,
    startDate,
    endDate,
    includeStaked = false,
  ) {
    console.log(
      `🔍 Fetching ARIO distributions (${
        includeStaked ? "liquid + staked" : "liquid only"
      }) for wallet: ${walletAddress}`,
    );
    console.log(`📅 Date range: ${startDate} to ${endDate}`);

    // Query operator rewards
    let operatorQuery;
    if (includeStaked) {
      operatorQuery = `
        SELECT epoch_index, gateway_address, operator_wallet, distributed_reward, is_staked
        FROM ario_operator_rewards
        WHERE operator_wallet = ?
        ALLOW FILTERING
      `;
    } else {
      // Fetch all rows and filter in JavaScript to handle null values
      // (Cassandra doesn't support IS NULL in WHERE clauses easily)
      operatorQuery = `
        SELECT epoch_index, gateway_address, operator_wallet, distributed_reward, is_staked
        FROM ario_operator_rewards
        WHERE operator_wallet = ?
        ALLOW FILTERING
      `;
    }

    const operatorResult = await this.arioDistributionClient.execute(
      operatorQuery,
      [walletAddress],
      { prepare: true },
    );

    // Query delegate rewards
    let delegateQuery;
    if (includeStaked) {
      delegateQuery = `
        SELECT epoch_index, gateway_address, delegate_wallet, distributed_reward, is_staked
        FROM ario_delegate_rewards
        WHERE delegate_wallet = ?
        ALLOW FILTERING
      `;
    } else {
      // Fetch all rows and filter in JavaScript to handle null values
      // (Cassandra doesn't support IS NULL in WHERE clauses easily)
      delegateQuery = `
        SELECT epoch_index, gateway_address, delegate_wallet, distributed_reward, is_staked
        FROM ario_delegate_rewards
        WHERE delegate_wallet = ?
        ALLOW FILTERING
      `;
    }

    const delegateResult = await this.arioDistributionClient.execute(
      delegateQuery,
      [walletAddress],
      { prepare: true },
    );

    console.log(
      `✅ Found ${operatorResult.rows.length} operator rewards and ${delegateResult.rows.length} delegate rewards`,
    );

    // Debug: Log sample rows to check is_staked values
    if (operatorResult.rows.length > 0) {
      const sampleRow = operatorResult.rows[0];
      console.log(
        `🔍 Sample operator reward - is_staked type: ${typeof sampleRow.is_staked}, value: ${JSON.stringify(
          sampleRow.is_staked,
        )}`,
      );
    }
    if (delegateResult.rows.length > 0) {
      const sampleRow = delegateResult.rows[0];
      console.log(
        `🔍 Sample delegate reward - is_staked type: ${typeof sampleRow.is_staked}, value: ${JSON.stringify(
          sampleRow.is_staked,
        )}`,
      );
    }

    // Process distributions and group by epoch and staking status
    const epochGroups = new Map();
    const epochTimestampCache = new Map(); // Cache epoch distribution timestamps

    // Filter rows if includeStaked is false (to exclude staked distributions)
    // This handles null values which Cassandra CQL can't easily filter in WHERE clauses
    const operatorRows = includeStaked
      ? operatorResult.rows
      : operatorResult.rows.filter(
          (row) =>
            row.is_staked === false ||
            row.is_staked === null ||
            row.is_staked === undefined,
        );
    const delegateRows = includeStaked
      ? delegateResult.rows
      : delegateResult.rows.filter(
          (row) =>
            row.is_staked === false ||
            row.is_staked === null ||
            row.is_staked === undefined,
        );

    console.log(
      `📊 After filtering: ${operatorRows.length} operator rewards, ${
        delegateRows.length
      } delegate rewards (liquid only: ${!includeStaked})`,
    );

    // Process operator rewards
    for (const row of operatorRows) {
      const epochIndex = parseInt(row.epoch_index.toString());
      // Handle is_staked: could be boolean, null, or string
      const isStakedRaw = row.is_staked;
      const isStaked =
        isStakedRaw === true ||
        isStakedRaw === "true" ||
        (typeof isStakedRaw === "string" &&
          isStakedRaw.toLowerCase() === "true");
      const groupKey = `${epochIndex}-${isStaked}`;

      if (!epochGroups.has(groupKey)) {
        epochGroups.set(groupKey, {
          epochIndex,
          date: null, // Will be set after fetching epoch data
          amount: 0,
          isStaked,
          gatewayAddresses: new Set(),
          distributionTimestamp: null, // Will be set after fetching epoch data
        });
      }

      const group = epochGroups.get(groupKey);
      const amount = parseFloat(row.distributed_reward.toString());
      group.amount += amount;
      group.gatewayAddresses.add(row.gateway_address);
    }

    // Process delegate rewards
    for (const row of delegateRows) {
      const epochIndex = parseInt(row.epoch_index.toString());
      // Handle is_staked: could be boolean, null, or string
      const isStakedRaw = row.is_staked;
      const isStaked =
        isStakedRaw === true ||
        isStakedRaw === "true" ||
        (typeof isStakedRaw === "string" &&
          isStakedRaw.toLowerCase() === "true");
      const groupKey = `${epochIndex}-${isStaked}`;

      if (!epochGroups.has(groupKey)) {
        epochGroups.set(groupKey, {
          epochIndex,
          date: null, // Will be set after fetching epoch data
          amount: 0,
          isStaked,
          gatewayAddresses: new Set(),
          distributionTimestamp: null, // Will be set after fetching epoch data
        });
      }

      const group = epochGroups.get(groupKey);
      const amount = parseFloat(row.distributed_reward.toString());
      group.amount += amount;
      group.gatewayAddresses.add(row.gateway_address);
    }

    // Fetch distribution timestamps from DB (ario_epochs_processed.distribution_timestamp).
    // Only epochs with a set distribution_timestamp are included; others are skipped.
    // To backfill: look up timestamps via SDK or GQL, then UPDATE ario_epochs_processed
    // SET distribution_timestamp = ? WHERE epoch_index = ?
    const uniqueEpochs = new Set(
      Array.from(epochGroups.values()).map((g) => g.epochIndex),
    );
    const epochList = Array.from(uniqueEpochs);
    if (epochList.length > 0) {
      try {
        const placeholders = epochList.map(() => "?").join(",");
        const query = `SELECT epoch_index, distribution_timestamp FROM ario_epochs_processed WHERE epoch_index IN (${placeholders})`;
        const result = await this.arioDistributionClient.execute(
          query,
          epochList,
          {
            prepare: true,
          },
        );
        for (const row of result.rows) {
          const epochIndex = parseInt(row.epoch_index.toString());
          const distTs = row.distribution_timestamp;
          if (distTs == null || distTs === undefined) continue;
          const ms =
            typeof distTs === "number"
              ? distTs
              : parseInt(distTs.toString(), 10);
          const d = new Date(ms);
          if (isNaN(d.getTime())) continue;
          const date = d.toISOString().split("T")[0];
          epochTimestampCache.set(epochIndex, { timestamp: d.getTime(), date });
        }
      } catch (error) {
        console.warn(
          `⚠️  Could not fetch epoch timestamps from DB: ${error.message}`,
        );
      }
    }

    // Set timestamps and dates for all groups, and filter by date range
    const filteredGroups = new Map();
    for (const [groupKey, group] of epochGroups) {
      const epochData = epochTimestampCache.get(group.epochIndex);
      if (epochData) {
        group.distributionTimestamp = epochData.timestamp;
        group.date = epochData.date;

        // Filter by date range
        if (group.date >= startDate && group.date <= endDate) {
          filteredGroups.set(groupKey, group);
        }
      } else {
        console.log(
          `⚠️  Skipping epoch ${group.epochIndex} - no distribution timestamp available`,
        );
      }
    }

    // Get gateway states for each distribution group using pre-computed state
    for (const [groupKey, group] of filteredGroups) {
      // Get gateway states for all gateways in this group using pre-computed state
      group.gatewayStates = new Map();
      for (const gatewayAddress of group.gatewayAddresses) {
        const gatewayState = await this.getGatewayStateForEpoch(
          group.epochIndex,
          gatewayAddress,
        );
        if (gatewayState) {
          group.gatewayStates.set(gatewayAddress, gatewayState);
        }
      }
    }

    // Convert to array and calculate ARIO (from mARIO)
    const distributions = Array.from(filteredGroups.values()).map((group) => {
      const isCorrupted = this.corruptedEpochs.some(
        (e) => e.epochIndex === group.epochIndex,
      );

      // Calculate gateway state statistics
      const gatewayStates = Array.from(group.gatewayStates.values());
      const autoStakeTrue = gatewayStates.filter(
        (g) => g.autoStake === true,
      ).length;
      const autoStakeFalse = gatewayStates.filter(
        (g) => g.autoStake === false,
      ).length;
      const autoStakeUnknown = gatewayStates.filter(
        (g) => g.autoStake === null,
      ).length;

      return {
        date: group.date,
        epochIndex: group.epochIndex,
        arioAmount: group.amount / Math.pow(10, CONFIG.TOKENS.ARIO.decimals),
        isStaked: group.isStaked,
        gatewayCount: group.gatewayAddresses.size,
        distributionTimestamp: group.distributionTimestamp,
        isCorrupted,
        gatewayStates: group.gatewayStates,
        gatewayStateStats: {
          autoStakeTrue,
          autoStakeFalse,
          autoStakeUnknown,
          total: gatewayStates.length,
        },
      };
    });

    // Sort by date, then by staking status (liquid first)
    distributions.sort((a, b) => {
      const dateCompare = new Date(a.date) - new Date(b.date);
      if (dateCompare !== 0) return dateCompare;
      return a.isStaked ? 1 : -1; // liquid first
    });

    // Debug: Log distribution counts by staking status
    const liquidCount = distributions.filter((d) => !d.isStaked).length;
    const stakedCount = distributions.filter((d) => d.isStaked).length;
    console.log(
      `📊 ARIO distributions: ${liquidCount} liquid, ${stakedCount} staked (total: ${distributions.length})`,
    );

    return distributions;
  }

  // Get gateway state for a specific epoch using pre-computed state table
  async getGatewayStateForEpoch(epochIndex, gatewayAddress) {
    try {
      const query = `
        SELECT * FROM gateway_state_by_epoch 
        WHERE epoch_index = ? AND gateway_address = ?
      `;

      const result = await this.gatewayClient.execute(
        query,
        [epochIndex, gatewayAddress],
        { prepare: true },
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        gatewayAddress: row.gateway_address,
        autoStake: Boolean(row.auto_stake),
        label: row.label,
        fqdn: row.fqdn,
        port: row.port,
        protocol: row.protocol,
        minDelegatedStake: row.min_delegated_stake,
        delegateRewardShareRatio: row.delegate_reward_share_ratio,
        note: row.note,
        allowDelegatedStaking: Boolean(row.allow_delegated_staking),
        properties: row.properties,
        lastActionTxId: row.last_action_txid,
        lastActionTimestamp: row.last_action_timestamp,
        lastActionType: row.last_action_type,
        source: "pre_computed",
      };
    } catch (error) {
      console.error(
        `❌ Error getting gateway state for ${gatewayAddress} at epoch ${epochIndex}:`,
        error.message,
      );
      return null;
    }
  }

  // Calculate USD values for distributions
  async convertPrice(usdPrice, currency, date, fiatService) {
    if (!fiatService || currency === "USD") return usdPrice;
    const rate = await fiatService.getRate(currency, date);
    if (rate === null) {
      console.warn(
        `⚠️ No exchange rate found for USD→${currency} on ${date}, using USD value`,
      );
      return usdPrice;
    }
    return usdPrice * rate;
  }

  async calculateValues(
    aoDistributions,
    piDistributions = [],
    arioDistributions = [],
    pixlDistributions = [],
    currency = "USD",
    fiatService = null,
  ) {
    console.log(
      `💰 Calculating ${currency} values${currency !== "USD" ? " (converting from USD base prices)" : ""}...`,
    );

    const processedDistributions = [];

    for (const dist of aoDistributions) {
      const usdValues = {};

      if (dist.aoAmount > 0) {
        const aoPrice = await this.getPriceData("AO", dist.date);
        if (aoPrice.price) {
          const convertedPrice = await this.convertPrice(
            aoPrice.price,
            currency,
            dist.date,
            fiatService,
          );
          usdValues.ao = {
            amount: dist.aoAmount,
            price: convertedPrice,
            usdValue: dist.aoAmount * convertedPrice,
            source: aoPrice.source,
          };
        } else {
          usdValues.ao = {
            amount: dist.aoAmount,
            price: null,
            usdValue: null,
            source: null,
          };
        }
      }

      processedDistributions.push({
        ...dist,
        usdValues,
        distributionType: "AO",
      });
    }

    for (const dist of piDistributions) {
      const usdValues = {};

      if (dist.piAmount > 0) {
        const piPrice = await this.getPriceData("PI", dist.date);
        if (piPrice.price) {
          const convertedPrice = await this.convertPrice(
            piPrice.price,
            currency,
            dist.date,
            fiatService,
          );
          usdValues.pi = {
            amount: dist.piAmount,
            price: convertedPrice,
            usdValue: dist.piAmount * convertedPrice,
            source: piPrice.source,
          };
        } else {
          usdValues.pi = {
            amount: dist.piAmount,
            price: null,
            usdValue: null,
            source: null,
          };
        }
      }

      processedDistributions.push({
        ...dist,
        usdValues,
        distributionType: "PI",
      });
    }

    for (const dist of arioDistributions) {
      const usdValues = {};

      if (dist.arioAmount > 0) {
        const arioPrice = await this.getPriceData("ARIO", dist.date);
        if (arioPrice.price) {
          const convertedPrice = await this.convertPrice(
            arioPrice.price,
            currency,
            dist.date,
            fiatService,
          );
          usdValues.ario = {
            amount: dist.arioAmount,
            price: convertedPrice,
            usdValue: dist.arioAmount * convertedPrice,
            source: arioPrice.source,
            isStaked: dist.isStaked,
          };
        } else {
          usdValues.ario = {
            amount: dist.arioAmount,
            price: null,
            usdValue: null,
            source: null,
            isStaked: dist.isStaked,
          };
        }
      }

      processedDistributions.push({
        ...dist,
        usdValues,
        distributionType: "ARIO",
      });
    }

    for (const dist of pixlDistributions) {
      const usdValues = {};

      if (dist.pixlAmount > 0) {
        const pixlPrice = await this.getPriceData("PIXL", dist.date);
        if (pixlPrice.price) {
          const convertedPrice = await this.convertPrice(
            pixlPrice.price,
            currency,
            dist.date,
            fiatService,
          );
          usdValues.pixl = {
            amount: dist.pixlAmount,
            amountUnits: dist.pixlAmountUnits,
            price: convertedPrice,
            usdValue: dist.pixlAmount * convertedPrice,
            source: pixlPrice.source,
            streakDays: dist.streakDays,
            streakMultiplier: dist.streakMultiplier,
          };
        } else {
          usdValues.pixl = {
            amount: dist.pixlAmount,
            amountUnits: dist.pixlAmountUnits,
            price: null,
            usdValue: null,
            source: null,
            streakDays: dist.streakDays,
            streakMultiplier: dist.streakMultiplier,
          };
        }
      }

      processedDistributions.push({
        ...dist,
        usdValues,
        distributionType: "PIXL",
      });
    }

    processedDistributions.sort((a, b) => new Date(a.date) - new Date(b.date));

    return processedDistributions;
  }

  // Generate PDF
  generatePDF(
    walletAddress,
    startDate,
    endDate,
    distributions,
    currency = "USD",
  ) {
    console.log("📄 Generating PDF...");

    const currencySymbol = this.getCurrencySymbol(currency);
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    let yPosition = 20;

    // Use Unicode-capable font so currency symbols (€, £, ₹, ₩, etc.) render correctly
    let reportFontName = "helvetica";
    try {
      const pkgPath = require.resolve("dejavu-fonts-ttf/package.json");
      const fontDir = path.join(path.dirname(pkgPath), "ttf");
      const sansPath = path.join(fontDir, "DejaVuSans.ttf");
      if (fs.existsSync(sansPath)) {
        const toBinaryString = (buf) => buf.toString("latin1");
        doc.addFileToVFS(
          "DejaVuSans.ttf",
          toBinaryString(fs.readFileSync(sansPath)),
        );
        doc.addFont("DejaVuSans.ttf", "DejaVuSans", "normal");
        doc.addFileToVFS(
          "DejaVuSans-Bold.ttf",
          toBinaryString(
            fs.readFileSync(path.join(fontDir, "DejaVuSans-Bold.ttf")),
          ),
        );
        doc.addFont("DejaVuSans-Bold.ttf", "DejaVuSans", "bold");
        doc.addFileToVFS(
          "DejaVuSans-Oblique.ttf",
          toBinaryString(
            fs.readFileSync(path.join(fontDir, "DejaVuSans-Oblique.ttf")),
          ),
        );
        doc.addFont("DejaVuSans-Oblique.ttf", "DejaVuSans", "italic");
        reportFontName = "DejaVuSans";
      }
    } catch (_) {}

    // Header
    doc.setFontSize(20);
    doc.setFont(reportFontName, "bold");
    doc.text("AO Taxable Distribution Report", pageWidth / 2, yPosition, {
      align: "center",
    });
    yPosition += 10;

    doc.setFontSize(12);
    doc.setFont(reportFontName, "normal");
    doc.text(
      "Generated by Giga Utility Tax Services",
      pageWidth / 2,
      yPosition,
      {
        align: "center",
      },
    );
    yPosition += 15;

    // Wallet info
    doc.setFontSize(12);
    doc.setFont(reportFontName, "normal");
    doc.text(`Wallet Address: ${walletAddress}`, 20, yPosition);
    yPosition += 8;
    doc.text(`Date Range: ${startDate} to ${endDate}`, 20, yPosition);
    yPosition += 8;
    doc.text(`Generated: ${new Date().toISOString()}`, 20, yPosition);
    yPosition += 20;

    // Summary statistics
    const totalAO = distributions.reduce(
      (sum, d) => sum + (d.usdValues.ao?.amount || 0),
      0,
    );
    const totalAOUSD = distributions.reduce(
      (sum, d) => sum + (d.usdValues.ao?.usdValue || 0),
      0,
    );
    const totalPI = distributions.reduce(
      (sum, d) => sum + (d.usdValues.pi?.amount || 0),
      0,
    );
    const totalPIUSD = distributions.reduce(
      (sum, d) => sum + (d.usdValues.pi?.usdValue || 0),
      0,
    );
    // Separate ARIO totals for liquid and staked
    const liquidArioDistributions = distributions.filter(
      (d) => d.distributionType === "ARIO" && !d.isStaked,
    );
    const stakedArioDistributions = distributions.filter(
      (d) => d.distributionType === "ARIO" && d.isStaked,
    );

    const totalARIO = liquidArioDistributions.reduce(
      (sum, d) => sum + (d.usdValues.ario?.amount || 0),
      0,
    );
    const totalARIOUSD = liquidArioDistributions.reduce(
      (sum, d) => sum + (d.usdValues.ario?.usdValue || 0),
      0,
    );
    const totalStakedARIO = stakedArioDistributions.reduce(
      (sum, d) => sum + (d.usdValues.ario?.amount || 0),
      0,
    );
    const totalStakedARIOUSD = stakedArioDistributions.reduce(
      (sum, d) => sum + (d.usdValues.ario?.usdValue || 0),
      0,
    );
    // PIXL totals
    const totalPIXL = distributions.reduce(
      (sum, d) => sum + (d.usdValues.pixl?.amount || 0),
      0,
    );
    const totalPIXLUSD = distributions.reduce(
      (sum, d) => sum + (d.usdValues.pixl?.usdValue || 0),
      0,
    );

    doc.setFontSize(14);
    doc.setFont(reportFontName, "bold");
    doc.text("Summary", 20, yPosition);
    yPosition += 10;

    doc.setFontSize(10);
    doc.setFont(reportFontName, "normal");

    if (totalAO > 0) {
      doc.text(`Total AO: ${totalAO.toFixed(12)} tokens`, 20, yPosition);
      yPosition += 6;
      doc.text(
        `Total AO Value: ${currencySymbol}${totalAOUSD.toFixed(4)}`,
        20,
        yPosition,
      );
      yPosition += 6;
    }

    if (totalPI > 0) {
      doc.text(`Total PI: ${totalPI.toFixed(12)} tokens`, 20, yPosition);
      yPosition += 6;
      doc.text(
        `Total PI Value: ${currencySymbol}${totalPIUSD.toFixed(4)}`,
        20,
        yPosition,
      );
      yPosition += 6;
    }

    if (totalARIO > 0 || totalStakedARIO > 0) {
      // Check if we have ARIO distributions that would indicate corrupted epochs are present
      // We infer corrupted epochs (13-15) by checking if we have data for epochs 12 and 16
      // COMMENTED OUT: Leaving logic for future use
      // const arioDistributions = distributions.filter(
      //   (d) => d.distributionType === "ARIO"
      // );
      // const hasEpoch12 = arioDistributions.some((d) => d.epochIndex === 12);
      // const hasEpoch16 = arioDistributions.some((d) => d.epochIndex === 16);
      // const hasCorruptedGap = hasEpoch12 && hasEpoch16;

      if (totalARIO > 0) {
        doc.text(
          `Total ARIO (Liquid): ${totalARIO.toFixed(6)} tokens`,
          20,
          yPosition,
        );
        yPosition += 6;
        doc.text(
          `Total ARIO Value: ${currencySymbol}${totalARIOUSD.toFixed(4)}`,
          20,
          yPosition,
        );
        yPosition += 6;
      }

      if (totalStakedARIO > 0) {
        doc.text(
          `Total ARIO (Staked): ${totalStakedARIO.toFixed(6)} tokens`,
          20,
          yPosition,
        );
        yPosition += 6;
        doc.text(
          `Total ARIO (Staked) Value: ${currencySymbol}${totalStakedARIOUSD.toFixed(
            4,
          )} (Generally not taxable until unstaked)`,
          20,
          yPosition,
        );
        yPosition += 6;
      }
    }

    if (totalPIXL > 0) {
      doc.text(`Total PIXL: ${totalPIXL.toFixed(6)} tokens`, 20, yPosition);
      yPosition += 6;
      doc.text(
        `Total PIXL Value: ${currencySymbol}${totalPIXLUSD.toFixed(4)}`,
        20,
        yPosition,
      );
      yPosition += 6;
    }

    doc.text(
      `Total Taxable Value: ${currencySymbol}${(
        totalAOUSD +
        totalPIUSD +
        totalARIOUSD +
        totalPIXLUSD
      ).toFixed(4)}`,
      20,
      yPosition,
    );
    yPosition += 15;

    // Distribution details
    doc.setFontSize(14);
    doc.setFont(reportFontName, "bold");
    doc.text("Distribution Details", 20, yPosition);
    yPosition += 10;

    // Separate distributions by type
    const aoDistributions = distributions.filter(
      (d) => d.distributionType === "AO",
    );
    const piDistributions = distributions.filter(
      (d) => d.distributionType === "PI",
    );
    const arioDistributions = distributions.filter(
      (d) => d.distributionType === "ARIO",
    );
    const pixlDistributions = distributions.filter(
      (d) => d.distributionType === "PIXL",
    );

    // Check if we have ARIO distributions that would indicate corrupted epochs are present
    // We infer corrupted epochs (13-15) by checking if we have data for epochs 12 and 16
    // COMMENTED OUT: Leaving logic for future use
    // const hasEpoch12 = arioDistributions.some((d) => d.epochIndex === 12);
    // const hasEpoch16 = arioDistributions.some((d) => d.epochIndex === 16);
    // const hasCorruptedGap = hasEpoch12 && hasEpoch16;

    // let footnoteText = null;
    // if (hasCorruptedGap && this.corruptedEpochs.length > 0) {
    //   const corruptedEpochNumbers = this.corruptedEpochs
    //     .map((e) => e.epochIndex)
    //     .sort((a, b) => a - b);
    //   const epochList = corruptedEpochNumbers.join(", ");
    //   footnoteText = `* The data for epochs ${epochList} is lost to time, completely unrecoverable. An unfortunate and ironic quirk of technology as new as AO. These epochs were corrupted during the testnet-to-mainnet migration and no distribution data exists.`;
    // }

    // Generic notice about AO infrastructure issues with ARIO token contract
    let footnoteText = null;
    const hasArioDistributions = arioDistributions.length > 0;
    if (hasArioDistributions) {
      footnoteText =
        "AO infrastructure issues with the ARIO token contract have resulted in the loss of some epoch distribution data. As such, distributions for the missing epochs do not appear in this report. The team at Giga Utility Tax Services is working diligently to see if this information is recoverable, and notice will be given to all affected users if they should update their reports because data was found. If the data is determined to be unrecoverable, Giga Utility Tax Services will update this report for maximum compliance with reporting laws, and attach an explanatory document to provide to your government's revenue collection agency.";
    }

    // AO Distributions Section
    if (aoDistributions.length > 0) {
      doc.setFontSize(12);
      doc.setFont(reportFontName, "bold");
      doc.text("AO Distributions", 20, yPosition);
      yPosition += 15;

      // AO Table headers
      doc.setFontSize(8);
      doc.setFont(reportFontName, "bold");
      const aoHeaders = ["Date", "AO Amount", "AO Price", "Distribution Value"];
      const aoColWidths = [30, 40, 40, 40];
      let xPosition = 10;

      for (let i = 0; i < aoHeaders.length; i++) {
        doc.text(aoHeaders[i], xPosition, yPosition);
        xPosition += aoColWidths[i];
      }
      yPosition += 8;
      doc.setFont(reportFontName, "normal");

      // AO Table data
      for (const dist of aoDistributions) {
        // Check if we need a new page
        if (yPosition > pageHeight - 20) {
          doc.addPage();
          yPosition = 20;
          doc.setFontSize(8);
          doc.setFont(reportFontName, "bold");
          xPosition = 10;
          for (let i = 0; i < aoHeaders.length; i++) {
            doc.text(aoHeaders[i], xPosition, yPosition);
            xPosition += aoColWidths[i];
          }
          yPosition += 8;
          doc.setFont(reportFontName, "normal");
        }

        xPosition = 10;

        // Date
        doc.text(dist.date, xPosition, yPosition);
        xPosition += aoColWidths[0];

        // AO Amount
        if (dist.usdValues.ao) {
          doc.text(dist.usdValues.ao.amount.toFixed(12), xPosition, yPosition);
          xPosition += aoColWidths[2];

          // AO Price
          if (dist.usdValues.ao.price) {
            doc.text(
              `${currencySymbol}${dist.usdValues.ao.price.toFixed(4)}`,
              xPosition,
              yPosition,
            );
            xPosition += aoColWidths[3];

            // AO USD
            doc.text(
              `${currencySymbol}${dist.usdValues.ao.usdValue.toFixed(8)}`,
              xPosition,
              yPosition,
            );
          } else {
            doc.text("0", xPosition, yPosition);
            xPosition += aoColWidths[3];
            doc.text(`${currencySymbol}0.00`, xPosition, yPosition);
          }
        } else {
          doc.text("0", xPosition, yPosition);
          xPosition += aoColWidths[2];
          doc.text("0", xPosition, yPosition);
          xPosition += aoColWidths[3];
          doc.text(`${currencySymbol}0.00`, xPosition, yPosition);
        }

        yPosition += 12; // Increased spacing between rows
      }
    }

    // PI Distributions Section
    if (piDistributions.length > 0) {
      // Add some space before PI section
      yPosition += 20;

      // Check if we need a new page before starting PI section
      // Ensure we have enough room for the header (12pt font + 15pt spacing) and table headers
      if (yPosition > pageHeight - 80) {
        doc.addPage();
        yPosition = 20;
      }

      doc.setFontSize(12);
      doc.setFont(reportFontName, "bold");
      doc.text("PI Distributions", 20, yPosition);
      yPosition += 15;

      // PI Table headers
      doc.setFontSize(8);
      doc.setFont(reportFontName, "bold");
      const piHeaders = ["Date", "PI Amount", "PI Price", "Distribution Value"];
      const piColWidths = [30, 40, 40, 40];
      let xPosition = 10;

      for (let i = 0; i < piHeaders.length; i++) {
        doc.text(piHeaders[i], xPosition, yPosition);
        xPosition += piColWidths[i];
      }
      yPosition += 8;
      doc.setFont(reportFontName, "normal");

      // PI Table data
      for (const dist of piDistributions) {
        // Check if we need a new page
        if (yPosition > pageHeight - 20) {
          doc.addPage();
          yPosition = 20;
          doc.setFontSize(8);
          doc.setFont(reportFontName, "bold");
          xPosition = 10;
          for (let i = 0; i < piHeaders.length; i++) {
            doc.text(piHeaders[i], xPosition, yPosition);
            xPosition += piColWidths[i];
          }
          yPosition += 8;
          doc.setFont(reportFontName, "normal");
        }

        xPosition = 10;

        // Date
        doc.text(dist.date, xPosition, yPosition);
        xPosition += piColWidths[0];

        // PI Amount
        if (dist.usdValues.pi) {
          doc.text(dist.usdValues.pi.amount.toFixed(12), xPosition, yPosition);
          xPosition += piColWidths[2];

          // PI Price
          if (dist.usdValues.pi.price) {
            doc.text(
              `${currencySymbol}${dist.usdValues.pi.price.toFixed(4)}`,
              xPosition,
              yPosition,
            );
            xPosition += piColWidths[3];

            // PI USD
            doc.text(
              `${currencySymbol}${dist.usdValues.pi.usdValue.toFixed(8)}`,
              xPosition,
              yPosition,
            );
          } else {
            doc.text("0", xPosition, yPosition);
            xPosition += piColWidths[3];
            doc.text(`${currencySymbol}0.00`, xPosition, yPosition);
          }
        } else {
          doc.text("0", xPosition, yPosition);
          xPosition += piColWidths[2];
          doc.text("0", xPosition, yPosition);
          xPosition += piColWidths[3];
          doc.text(`${currencySymbol}0.00`, xPosition, yPosition);
        }

        yPosition += 12; // Increased spacing between rows
      }
    }

    // Separate ARIO distributions into liquid and staked for PDF display
    const liquidArioForPDF = arioDistributions.filter((d) => !d.isStaked);
    const stakedArioForPDF = arioDistributions.filter((d) => d.isStaked);

    // ARIO Liquid Distributions Section
    if (liquidArioForPDF.length > 0) {
      // Add some space before ARIO Liquid section
      yPosition += 20;

      // Check if we need a new page
      if (yPosition > pageHeight - 40) {
        doc.addPage();
        yPosition = 20;
      }

      doc.setFontSize(12);
      doc.setFont(reportFontName, "bold");
      doc.text("ARIO Liquid Distributions", 20, yPosition);
      yPosition += 15;

      // ARIO Liquid Table headers
      doc.setFontSize(8);
      doc.setFont(reportFontName, "bold");
      const arioLiquidHeaders = [
        "Date",
        "Epoch",
        "ARIO Amount",
        "ARIO Price",
        "Distribution Value",
      ];
      const arioLiquidColWidths = [25, 20, 30, 30, 30];
      let xPosition = 10;

      for (let i = 0; i < arioLiquidHeaders.length; i++) {
        doc.text(arioLiquidHeaders[i], xPosition, yPosition);
        xPosition += arioLiquidColWidths[i];
      }
      yPosition += 8;
      doc.setFont(reportFontName, "normal");

      // ARIO Liquid Table data
      for (const dist of liquidArioForPDF) {
        // Check if we need a new page
        if (yPosition > pageHeight - 20) {
          doc.addPage();
          yPosition = 20;
          doc.setFontSize(8);
          doc.setFont(reportFontName, "bold");
          xPosition = 10;
          for (let i = 0; i < arioLiquidHeaders.length; i++) {
            doc.text(arioLiquidHeaders[i], xPosition, yPosition);
            xPosition += arioLiquidColWidths[i];
          }
          yPosition += 8;
          doc.setFont(reportFontName, "normal");
        }

        xPosition = 10;

        // Date
        doc.text(dist.date, xPosition, yPosition);
        xPosition += arioLiquidColWidths[0];

        // Epoch
        doc.text(`${dist.epochIndex}`, xPosition, yPosition);
        xPosition += arioLiquidColWidths[1];

        // ARIO Amount
        if (dist.usdValues.ario) {
          doc.text(dist.usdValues.ario.amount.toFixed(6), xPosition, yPosition);
          xPosition += arioLiquidColWidths[2];

          // ARIO Price
          if (dist.usdValues.ario.price) {
            doc.text(
              `${currencySymbol}${dist.usdValues.ario.price.toFixed(4)}`,
              xPosition,
              yPosition,
            );
            xPosition += arioLiquidColWidths[3];

            // ARIO USD
            doc.text(
              `${currencySymbol}${dist.usdValues.ario.usdValue.toFixed(8)}`,
              xPosition,
              yPosition,
            );
          } else {
            doc.text("0", xPosition, yPosition);
            xPosition += arioLiquidColWidths[3];
            doc.text(`${currencySymbol}0.00`, xPosition, yPosition);
          }
        } else {
          doc.text("0", xPosition, yPosition);
          xPosition += arioLiquidColWidths[2];
          doc.text("0", xPosition, yPosition);
          xPosition += arioLiquidColWidths[3];
          doc.text(`${currencySymbol}0.00`, xPosition, yPosition);
        }

        yPosition += 12; // Increased spacing between rows
      }
    }

    // ARIO Staked Distributions Section
    if (stakedArioForPDF.length > 0) {
      // Add some space before ARIO Staked section
      yPosition += 20;

      // Check if we need a new page
      if (yPosition > pageHeight - 40) {
        doc.addPage();
        yPosition = 20;
      }

      doc.setFontSize(12);
      doc.setFont(reportFontName, "bold");
      doc.text("ARIO Staked Distributions", 20, yPosition);
      yPosition += 15;

      // Add tax note for staked distributions
      doc.setFontSize(9);
      doc.setFont(reportFontName, "italic");
      doc.text(
        "Note: Reward distributions that are automatically staked are generally",
        20,
        yPosition,
      );
      yPosition += 6;
      doc.text(
        "not taxable until full custody and control is exercised by unstaking them.",
        20,
        yPosition,
      );
      yPosition += 15;

      // ARIO Staked Table headers
      doc.setFontSize(8);
      doc.setFont(reportFontName, "bold");
      const arioStakedHeaders = [
        "Date",
        "Epoch",
        "ARIO Amount",
        "ARIO Price",
        "Distribution Value",
      ];
      const arioStakedColWidths = [25, 20, 25, 25, 25];
      let xPosition = 10;

      for (let i = 0; i < arioStakedHeaders.length; i++) {
        doc.text(arioStakedHeaders[i], xPosition, yPosition);
        xPosition += arioStakedColWidths[i];
      }
      yPosition += 8;
      doc.setFont(reportFontName, "normal");

      // ARIO Staked Table data
      for (const dist of stakedArioForPDF) {
        // Check if we need a new page
        if (yPosition > pageHeight - 20) {
          doc.addPage();
          yPosition = 20;
          doc.setFontSize(8);
          doc.setFont(reportFontName, "bold");
          xPosition = 10;
          for (let i = 0; i < arioStakedHeaders.length; i++) {
            doc.text(arioStakedHeaders[i], xPosition, yPosition);
            xPosition += arioStakedColWidths[i];
          }
          yPosition += 8;
          doc.setFont(reportFontName, "normal");
        }

        xPosition = 10;

        // Date
        doc.text(dist.date, xPosition, yPosition);
        xPosition += arioStakedColWidths[0];

        // Epoch
        doc.text(`${dist.epochIndex}`, xPosition, yPosition);
        xPosition += arioStakedColWidths[1];

        // ARIO Amount
        if (dist.usdValues.ario) {
          doc.text(dist.usdValues.ario.amount.toFixed(6), xPosition, yPosition);
          xPosition += arioStakedColWidths[2];

          // ARIO Price
          if (dist.usdValues.ario.price) {
            doc.text(
              `${currencySymbol}${dist.usdValues.ario.price.toFixed(4)}`,
              xPosition,
              yPosition,
            );
            xPosition += arioStakedColWidths[3];

            // ARIO USD
            doc.text(
              `${currencySymbol}${dist.usdValues.ario.usdValue.toFixed(8)}`,
              xPosition,
              yPosition,
            );
          } else {
            doc.text("0", xPosition, yPosition);
            xPosition += arioStakedColWidths[3];
            doc.text(`${currencySymbol}0.00`, xPosition, yPosition);
          }
        } else {
          doc.text("0", xPosition, yPosition);
          xPosition += arioStakedColWidths[2];
          doc.text("0", xPosition, yPosition);
          xPosition += arioStakedColWidths[3];
          doc.text(`${currencySymbol}0.00`, xPosition, yPosition);
        }

        yPosition += 12; // Increased spacing between rows
      }
    }

    // PIXL Distributions Section
    if (pixlDistributions.length > 0) {
      // Add some space before PIXL section
      yPosition += 20;

      // Check if we need a new page
      if (yPosition > pageHeight - 40) {
        doc.addPage();
        yPosition = 20;
      }

      doc.setFontSize(12);
      doc.setFont(reportFontName, "bold");
      doc.text("PIXL Streak Distributions", 20, yPosition);
      yPosition += 15;

      // PIXL Table headers
      doc.setFontSize(8);
      doc.setFont(reportFontName, "bold");
      const pixlHeaders = [
        "Date",
        "Streak Days",
        "PIXL Amount",
        "PIXL Price",
        "Distribution Value",
      ];
      const pixlColWidths = [25, 25, 30, 30, 30];
      let xPosition = 10;

      for (let i = 0; i < pixlHeaders.length; i++) {
        doc.text(pixlHeaders[i], xPosition, yPosition);
        xPosition += pixlColWidths[i];
      }
      yPosition += 8;
      doc.setFont(reportFontName, "normal");

      // PIXL Table data
      for (const dist of pixlDistributions) {
        // Check if we need a new page
        if (yPosition > pageHeight - 20) {
          doc.addPage();
          yPosition = 20;
          doc.setFontSize(8);
          doc.setFont(reportFontName, "bold");
          xPosition = 10;
          for (let i = 0; i < pixlHeaders.length; i++) {
            doc.text(pixlHeaders[i], xPosition, yPosition);
            xPosition += pixlColWidths[i];
          }
          yPosition += 8;
          doc.setFont(reportFontName, "normal");
        }

        xPosition = 10;

        // Date
        doc.text(dist.date, xPosition, yPosition);
        xPosition += pixlColWidths[0];

        // Streak Days
        const streakDays =
          dist.streakDays || dist.usdValues.pixl?.streakDays || 0;
        doc.text(`${streakDays}`, xPosition, yPosition);
        xPosition += pixlColWidths[1];

        // PIXL Amount
        if (dist.usdValues.pixl) {
          doc.text(dist.usdValues.pixl.amount.toFixed(6), xPosition, yPosition);
          xPosition += pixlColWidths[2];

          // PIXL Price
          if (dist.usdValues.pixl.price) {
            doc.text(
              `${currencySymbol}${dist.usdValues.pixl.price.toFixed(6)}`,
              xPosition,
              yPosition,
            );
            xPosition += pixlColWidths[3];

            // PIXL USD
            doc.text(
              `${currencySymbol}${dist.usdValues.pixl.usdValue.toFixed(8)}`,
              xPosition,
              yPosition,
            );
          } else {
            doc.text("0", xPosition, yPosition);
            xPosition += pixlColWidths[3];
            doc.text(`${currencySymbol}0.00`, xPosition, yPosition);
          }
        } else {
          doc.text("0", xPosition, yPosition);
          xPosition += pixlColWidths[2];
          doc.text("0", xPosition, yPosition);
          xPosition += pixlColWidths[3];
          doc.text(`${currencySymbol}0.00`, xPosition, yPosition);
        }

        yPosition += 12; // Increased spacing between rows
      }
    }

    // Add footnote for corrupted epochs if needed
    if (footnoteText) {
      yPosition += 20;

      // Check if we need a new page
      if (yPosition > pageHeight - 60) {
        doc.addPage();
        yPosition = 20;
      }

      doc.setFontSize(8);
      doc.setFont(reportFontName, "italic");

      // Add the footnote text (wrap it)
      doc.setFontSize(7);
      const wrappedFootnote = doc.splitTextToSize(footnoteText, pageWidth - 20);
      doc.text(wrappedFootnote, 10, yPosition);
      yPosition += wrappedFootnote.length * 4 + 10; // Adjust position after footnote
    }

    // Add price aggregation notice at the very end
    yPosition += 20;

    // Check if we need a new page
    if (yPosition > pageHeight - 20) {
      doc.addPage();
      yPosition = 20;
    }

    doc.setFontSize(7);
    doc.setFont(reportFontName, "italic");
    doc.text(
      "Price aggregations may include data from CoinGecko",
      20,
      yPosition,
    );
    yPosition += 8;
    doc.text(
      "Please report any suspected inaccuracies to admin@gigautility.com",
      20,
      yPosition,
    );

    return doc;
  }

  async generateReport(
    walletAddress,
    startDate,
    endDate,
    outputPath,
    includeStaked = false,
    options = {},
  ) {
    const currency = options.currency || "USD";
    const currencySymbol = this.getCurrencySymbol(currency);
    let fiatService = null;

    try {
      await this.init();

      if (currency !== "USD") {
        fiatService = new FiatConversionService();
        await fiatService.connect();
        const testRate = await fiatService.getRate(currency, endDate);
        if (testRate === null) {
          throw new Error(
            `No exchange rate data available for ${currency}. Ensure the fiat rate indexer has been run.`,
          );
        }
      }

      console.log(
        `\n🚀 Generating distribution report for wallet: ${walletAddress}`,
      );
      console.log(
        `📅 Date range: ${startDate} to ${endDate}${currency !== "USD" ? ` [${currency}]` : ""}`,
      );

      const aoDistributions = await this.getWalletDistributions(
        walletAddress,
        startDate,
        endDate,
      );

      const piDistributions = await this.getPIWalletDistributions(
        walletAddress,
        startDate,
        endDate,
      );

      const arioDistributions = await this.getARIOWalletDistributions(
        walletAddress,
        startDate,
        endDate,
        includeStaked,
      );

      const pixlDistributions = await this.getPIXLWalletDistributions(
        walletAddress,
        startDate,
        endDate,
      );

      if (
        aoDistributions.length === 0 &&
        piDistributions.length === 0 &&
        arioDistributions.length === 0 &&
        pixlDistributions.length === 0
      ) {
        console.log(
          "❌ No distributions found for the specified wallet and date range",
        );
        return;
      }

      const distributionsWithValues = await this.calculateValues(
        aoDistributions,
        piDistributions,
        arioDistributions,
        pixlDistributions,
        currency,
        fiatService,
      );

      const pdf = this.generatePDF(
        walletAddress,
        startDate,
        endDate,
        distributionsWithValues,
        currency,
      );

      pdf.save(outputPath);
      console.log(`✅ PDF saved to: ${outputPath}`);

      const totalAO = distributionsWithValues.reduce(
        (sum, d) => sum + (d.usdValues.ao?.amount || 0),
        0,
      );
      const totalAOVal = distributionsWithValues.reduce(
        (sum, d) => sum + (d.usdValues.ao?.usdValue || 0),
        0,
      );
      const totalPI = distributionsWithValues.reduce(
        (sum, d) => sum + (d.usdValues.pi?.amount || 0),
        0,
      );
      const totalPIVal = distributionsWithValues.reduce(
        (sum, d) => sum + (d.usdValues.pi?.usdValue || 0),
        0,
      );
      const liquidArioDistributions = distributionsWithValues.filter(
        (d) => d.distributionType === "ARIO" && !d.isStaked,
      );
      const stakedArioDistributions = distributionsWithValues.filter(
        (d) => d.distributionType === "ARIO" && d.isStaked,
      );

      const totalARIO = liquidArioDistributions.reduce(
        (sum, d) => sum + (d.usdValues.ario?.amount || 0),
        0,
      );
      const totalARIOVal = liquidArioDistributions.reduce(
        (sum, d) => sum + (d.usdValues.ario?.usdValue || 0),
        0,
      );
      const totalStakedARIO = stakedArioDistributions.reduce(
        (sum, d) => sum + (d.usdValues.ario?.amount || 0),
        0,
      );
      const totalPIXL = distributionsWithValues.reduce(
        (sum, d) => sum + (d.usdValues.pixl?.amount || 0),
        0,
      );
      const totalPIXLVal = distributionsWithValues.reduce(
        (sum, d) => sum + (d.usdValues.pixl?.usdValue || 0),
        0,
      );

      console.log(`\n📊 Report Summary (${currency}):`);
      console.log(`   Total Distributions: ${distributionsWithValues.length}`);
      if (totalAO > 0) {
        console.log(
          `   Total AO: ${totalAO.toFixed(12)} tokens (${currencySymbol}${totalAOVal.toFixed(4)})`,
        );
      }
      if (totalPI > 0) {
        console.log(
          `   Total PI: ${totalPI.toFixed(12)} tokens (${currencySymbol}${totalPIVal.toFixed(4)})`,
        );
      }
      if (totalARIO > 0) {
        console.log(
          `   Total ARIO (Liquid): ${totalARIO.toFixed(6)} tokens (${currencySymbol}${totalARIOVal.toFixed(4)})`,
        );
      }
      if (totalStakedARIO > 0) {
        console.log(
          `   Total ARIO (Staked): ${totalStakedARIO.toFixed(6)} tokens`,
        );
      }
      if (totalPIXL > 0) {
        console.log(
          `   Total PIXL: ${totalPIXL.toFixed(6)} tokens (${currencySymbol}${totalPIXLVal.toFixed(4)})`,
        );
      }
      console.log(
        `   Total Value: ${currencySymbol}${(
          totalAOVal +
          totalPIVal +
          totalARIOVal +
          totalPIXLVal
        ).toFixed(4)}`,
      );
    } catch (error) {
      console.error("❌ PDF generation failed:", error.message);
      throw error;
    } finally {
      if (fiatService) {
        await fiatService.disconnect();
      }
      if (this.priceClient) {
        await this.priceClient.shutdown();
      }
      if (this.distributionClient) {
        await this.distributionClient.shutdown();
      }
      if (this.piDistributionClient) {
        await this.piDistributionClient.shutdown();
      }
      if (this.arioDistributionClient) {
        await this.arioDistributionClient.shutdown();
      }
      if (this.pixlDistributionClient) {
        await this.pixlDistributionClient.shutdown();
      }
      if (this.dexPriceClient) {
        await this.dexPriceClient.shutdown();
      }
      if (this.gatewayClient) {
        await this.gatewayClient.shutdown();
      }
      console.log("🔌 Database connections closed");
    }
  }

  async cleanup() {
    try {
      if (this.priceClient) {
        await this.priceClient.shutdown();
        console.log("🔌 Price database connection closed");
      }
      if (this.distributionClient) {
        await this.distributionClient.shutdown();
        console.log("🔌 AO distribution database connection closed");
      }
      if (this.piDistributionClient) {
        await this.piDistributionClient.shutdown();
        console.log("🔌 PI distribution database connection closed");
      }
      if (this.arioDistributionClient) {
        await this.arioDistributionClient.shutdown();
        console.log("🔌 ARIO distribution database connection closed");
      }
      if (this.pixlDistributionClient) {
        await this.pixlDistributionClient.shutdown();
        console.log("🔌 PIXL distribution database connection closed");
      }
      if (this.dexPriceClient) {
        await this.dexPriceClient.shutdown();
        console.log("🔌 DEX price database connection closed");
      }
      if (this.gatewayClient) {
        await this.gatewayClient.shutdown();
        console.log("🔌 Gateway database connection closed");
      }
    } catch (error) {
      console.error("❌ Error during cleanup:", error.message);
    }
  }
}

// Parse command line arguments
function parseArguments() {
  const args = process.argv.slice(2);
  const options = {
    wallet: null,
    startDate: null,
    endDate: null,
    output: null,
    includeStaked: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--wallet" || arg === "-w") {
      options.wallet = args[i + 1];
      i++;
    } else if (arg === "--start" || arg === "-s") {
      options.startDate = args[i + 1];
      i++;
    } else if (arg === "--end" || arg === "-e") {
      options.endDate = args[i + 1];
      i++;
    } else if (arg === "--output" || arg === "-o") {
      options.output = args[i + 1];
      i++;
    } else if (arg === "--include-staked" || arg === "--staked") {
      options.includeStaked = true;
    } else if (arg.startsWith("--wallet=")) {
      options.wallet = arg.split("=")[1];
    } else if (arg.startsWith("--start=")) {
      options.startDate = arg.split("=")[1];
    } else if (arg.startsWith("--end=")) {
      options.endDate = arg.split("=")[1];
    } else if (arg.startsWith("--output=")) {
      options.output = arg.split("=")[1];
    }
  }

  return options;
}

// Display help information
function showHelp() {
  console.log(`
📄 Wallet Distribution PDF Generator

USAGE:
  node wallet_distribution_pdf_generator.js [OPTIONS]

OPTIONS:
  --wallet, -w <address>    Wallet address to analyze (required)
  --start, -s <date>        Start date (YYYY-MM-DD) (required)
  --end, -e <date>          End date (YYYY-MM-DD) (required)
  --output, -o <path>       Output PDF file path (optional, defaults to wallet-YYYY-MM-DD.pdf)
  --include-staked, --staked Include staked ARIO distributions (no USD value)
  --help, -h                Show this help message

EXAMPLES:
  # Generate report for specific wallet and date range
  node wallet_distribution_pdf_generator.js --wallet gwHwsVe6glDUSOnfh5Ci1ZFWz8v2wXBhyhJpeKBN0pk --start 2025-01-01 --end 2025-10-02

  # Generate report with custom output path
  node wallet_distribution_pdf_generator.js -w gwHwsVe6glDUSOnfh5Ci1ZFWz8v2wXBhyhJpeKBN0pk -s 2025-06-01 -e 2025-08-31 -o my-report.pdf

  # Include staked ARIO distributions
  node wallet_distribution_pdf_generator.js -w gwHwsVe6glDUSOnfh5Ci1ZFWz8v2wXBhyhJpeKBN0pk -s 2025-01-01 -e 2025-10-02 --include-staked

DESCRIPTION:
  This script generates a comprehensive PDF report showing all distributions
  for a given wallet within a specified date range, including:
  
  - Distribution details (date, transaction ID, amounts)
  - USD valuations using CoinGecko prices (with Permaswap fallback)
  - Price source information (CoinGecko vs Permaswap)
  - Summary statistics
  - Precise calculations without rounding or truncation
  - ARIO distributions (liquid only by default, staked optional)

FEATURES:
  - CoinGecko price priority with Permaswap fallback
  - Precise USD calculations (no rounding/truncation)
  - Comprehensive distribution details
  - Professional PDF formatting
  - Multi-token support (AO, PI, and ARIO)
  - Corrupted epoch detection with footnotes
  - Optional staked ARIO inclusion
`);
}

// Validate date format
function validateDate(dateString) {
  const date = new Date(dateString);
  const isoString = date.toISOString().split("T")[0];
  return isoString === dateString;
}

// Main execution
async function main() {
  const options = parseArguments();

  if (options.help) {
    showHelp();
    return;
  }

  // Validate required arguments
  if (!options.wallet) {
    console.error("❌ Wallet address is required. Use --wallet or -w");
    process.exit(1);
  }

  if (!options.startDate) {
    console.error("❌ Start date is required. Use --start or -s");
    process.exit(1);
  }

  if (!options.endDate) {
    console.error("❌ End date is required. Use --end or -e");
    process.exit(1);
  }

  // Validate dates
  if (!validateDate(options.startDate)) {
    console.error("❌ Invalid start date format. Use YYYY-MM-DD");
    process.exit(1);
  }

  if (!validateDate(options.endDate)) {
    console.error("❌ Invalid end date format. Use YYYY-MM-DD");
    process.exit(1);
  }

  // Validate date range
  const start = new Date(options.startDate);
  const end = new Date(options.endDate);

  if (start > end) {
    console.error("❌ Start date must be before end date");
    process.exit(1);
  }

  // Set default output path if not provided
  if (!options.output) {
    const shortWallet = options.wallet.substring(0, 8);
    options.output = `wallet-${shortWallet}-${options.startDate}-to-${options.endDate}.pdf`;
  }

  const generator = new WalletDistributionPDFGenerator();

  try {
    await generator.generateReport(
      options.wallet,
      options.startDate,
      options.endDate,
      options.output,
      options.includeStaked,
    );
  } catch (error) {
    console.error("❌ Fatal error:", error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { WalletDistributionPDFGenerator, CONFIG };
