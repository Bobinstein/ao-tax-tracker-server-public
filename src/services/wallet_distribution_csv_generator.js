#!/usr/bin/env node

const cassandra = require("cassandra-driver");
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

class WalletDistributionCSVGenerator {
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
    console.log("🔌 Initializing CSV Generator...");

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

    console.log("✅ CSV Generator initialized");
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

  // Get price data with CoinGecko priority (same as PDF generator)
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
            try {
              price = parseFloat(priceUsd.toString());
            } catch (e) {
              const intVal = priceUsd._intVal;
              let scale = priceUsd._scale;

              if (scale > 1000 || scale < -1000) {
                console.log(
                  `⚠️  Corrupted scale detected: ${scale}, using default scale of 6`,
                );
                scale = 6;

                if (intVal && typeof intVal.toString === "function") {
                  const intStr = intVal.toString();
                  if (intStr.length > 0) {
                    const rawPrice = parseInt(intStr) / Math.pow(10, 6);
                    if (rawPrice > 0 && rawPrice < 10000) {
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
                if (scale < 0) {
                  const zeros = "0".repeat(Math.abs(scale));
                  const decimalStr = intStr + zeros;
                  price = parseFloat(decimalStr);
                } else {
                  if (intStr.length <= scale) {
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

      // Second priority: Permaswap-AO
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

          if (priceUsd.constructor.name === "BigDecimal") {
            try {
              price = parseFloat(priceUsd.toString());
            } catch (e) {
              const intVal = priceUsd._intVal;
              let scale = priceUsd._scale;

              if (scale > 1000 || scale < -1000) {
                scale = 6;
                if (intVal && typeof intVal.toString === "function") {
                  const intStr = intVal.toString();
                  if (intStr.length > 0) {
                    const rawPrice = parseInt(intStr) / Math.pow(10, 6);
                    if (rawPrice > 0 && rawPrice < 10000) {
                      price = rawPrice;
                    }
                  }
                }
              }

              if (intVal && typeof intVal.toString === "function") {
                const intStr = intVal.toString();
                if (scale < 0) {
                  const zeros = "0".repeat(Math.abs(scale));
                  const decimalStr = intStr + zeros;
                  price = parseFloat(decimalStr);
                } else {
                  if (intStr.length <= scale) {
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

      // Third priority: Permaswap-GQL
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

          if (priceUsd.constructor.name === "BigDecimal") {
            try {
              price = parseFloat(priceUsd.toString());
            } catch (e) {
              const intVal = priceUsd._intVal;
              let scale = priceUsd._scale;

              if (scale > 1000 || scale < -1000) {
                scale = 6;
                if (intVal && typeof intVal.toString === "function") {
                  const intStr = intVal.toString();
                  if (intStr.length > 0) {
                    const rawPrice = parseInt(intStr) / Math.pow(10, 6);
                    if (rawPrice > 0 && rawPrice < 10000) {
                      price = rawPrice;
                    }
                  }
                }
              }

              if (intVal && typeof intVal.toString === "function") {
                const intStr = intVal.toString();
                if (scale < 0) {
                  const zeros = "0".repeat(Math.abs(scale));
                  const decimalStr = intStr + zeros;
                  price = parseFloat(decimalStr);
                } else {
                  if (intStr.length <= scale) {
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

      // Fallback: Old permaswap source
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

      // No price data found for this exact date - try forward-fill
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
      console.log(
        `⚠️  Error getting DEX price for ${tokenSymbol}: ${error.message}`,
      );
      return null;
    }
  }

  async getForwardFillPrice(tokenSymbol, date) {
    try {
      const query = `
        SELECT date, price_usd, data_source
        FROM daily_prices
        WHERE token_symbol = ? AND date < ?
        ALLOW FILTERING
      `;

      const result = await this.priceClient.execute(query, [tokenSymbol, date]);

      if (result.rows.length > 0) {
        const sortedRows = result.rows.sort((a, b) => {
          return b.date.localeCompare(a.date);
        });

        const mostRecent = sortedRows[0];
        try {
          const priceUsd = mostRecent.price_usd;
          let price;

          if (priceUsd.constructor.name === "BigDecimal") {
            try {
              price = parseFloat(priceUsd.toString());
            } catch (e) {
              const intVal = priceUsd._intVal;
              let scale = priceUsd._scale;

              if (scale > 1000 || scale < -1000) {
                scale = 6;
                if (intVal && typeof intVal.toString === "function") {
                  const intStr = intVal.toString();
                  if (intStr.length > 0) {
                    const rawPrice = parseInt(intStr) / Math.pow(10, 6);
                    if (rawPrice > 0 && rawPrice < 10000) {
                      price = rawPrice;
                    }
                  }
                }
              }

              if (intVal && typeof intVal.toString === "function") {
                const intStr = intVal.toString();
                if (scale < 0) {
                  const zeros = "0".repeat(Math.abs(scale));
                  const decimalStr = intStr + zeros;
                  price = parseFloat(decimalStr);
                } else {
                  if (intStr.length <= scale) {
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

  // Get wallet distributions (same as PDF generator)
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

    const distributions = [];
    for (const row of result.rows) {
      const distributionDate = row.date;

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

    distributions.sort((a, b) => new Date(a.date) - new Date(b.date));

    return distributions;
  }

  // Get PI distributions (same as PDF generator)
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

    const distributions = [];
    for (const row of result.rows) {
      const distributionDate = row.date;

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

  // Get ARIO distributions (same as PDF generator)
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

    let operatorQuery = `
      SELECT epoch_index, gateway_address, operator_wallet, distributed_reward, is_staked
      FROM ario_operator_rewards
      WHERE operator_wallet = ?
      ALLOW FILTERING
    `;

    const operatorResult = await this.arioDistributionClient.execute(
      operatorQuery,
      [walletAddress],
      { prepare: true },
    );

    let delegateQuery = `
      SELECT epoch_index, gateway_address, delegate_wallet, distributed_reward, is_staked
      FROM ario_delegate_rewards
      WHERE delegate_wallet = ?
      ALLOW FILTERING
    `;

    const delegateResult = await this.arioDistributionClient.execute(
      delegateQuery,
      [walletAddress],
      { prepare: true },
    );

    console.log(
      `✅ Found ${operatorResult.rows.length} operator rewards and ${delegateResult.rows.length} delegate rewards`,
    );

    const epochGroups = new Map();
    const epochTimestampCache = new Map();

    // Filter rows if includeStaked is false
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
          date: null,
          amount: 0,
          isStaked,
          gatewayAddresses: new Set(),
          distributionTimestamp: null,
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
          date: null,
          amount: 0,
          isStaked,
          gatewayAddresses: new Set(),
          distributionTimestamp: null,
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

        if (group.date >= startDate && group.date <= endDate) {
          filteredGroups.set(groupKey, group);
        }
      } else {
        console.log(
          `⚠️  Skipping epoch ${group.epochIndex} - no distribution timestamp available`,
        );
      }
    }

    // Get gateway states for each distribution group
    for (const [groupKey, group] of filteredGroups) {
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
      return a.isStaked ? 1 : -1;
    });

    const liquidCount = distributions.filter((d) => !d.isStaked).length;
    const stakedCount = distributions.filter((d) => d.isStaked).length;
    console.log(
      `📊 ARIO distributions: ${liquidCount} liquid, ${stakedCount} staked (total: ${distributions.length})`,
    );

    return distributions;
  }

  // Get gateway state for a specific epoch (same as PDF generator)
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

  // Escape CSV field (handle quotes and commas)
  escapeCSVField(field) {
    if (field === null || field === undefined) {
      return "";
    }
    const str = String(field);
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  // Generate CSV
  generateCSV(walletAddress, startDate, endDate, distributions, currency = "USD") {
    console.log("📄 Generating CSV...");

    const rows = [];

    rows.push(
      `Distribution Date,Token,Distribution Amount,Token Price (${currency}),Distribution Value (${currency}),Liquid/Staked`,
    );

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

    // Process AO distributions
    for (const dist of aoDistributions) {
      const date = this.escapeCSVField(dist.date);
      const token = this.escapeCSVField("AO");
      const amount = dist.usdValues.ao
        ? this.escapeCSVField(dist.usdValues.ao.amount.toFixed(12))
        : this.escapeCSVField("0");
      const price = dist.usdValues.ao?.price
        ? this.escapeCSVField(dist.usdValues.ao.price.toFixed(4))
        : this.escapeCSVField("0");
      const usdValue = dist.usdValues.ao?.usdValue
        ? this.escapeCSVField(dist.usdValues.ao.usdValue.toFixed(8))
        : this.escapeCSVField("0");
      const stakingStatus = this.escapeCSVField("Liquid"); // AO and PI are always liquid

      rows.push(
        `${date},${token},${amount},${price},${usdValue},${stakingStatus}`,
      );
    }

    // Process PI distributions
    for (const dist of piDistributions) {
      const date = this.escapeCSVField(dist.date);
      const token = this.escapeCSVField("PI");
      const amount = dist.usdValues.pi
        ? this.escapeCSVField(dist.usdValues.pi.amount.toFixed(12))
        : this.escapeCSVField("0");
      const price = dist.usdValues.pi?.price
        ? this.escapeCSVField(dist.usdValues.pi.price.toFixed(4))
        : this.escapeCSVField("0");
      const usdValue = dist.usdValues.pi?.usdValue
        ? this.escapeCSVField(dist.usdValues.pi.usdValue.toFixed(8))
        : this.escapeCSVField("0");
      const stakingStatus = this.escapeCSVField("Liquid"); // AO and PI are always liquid

      rows.push(
        `${date},${token},${amount},${price},${usdValue},${stakingStatus}`,
      );
    }

    // Process ARIO distributions (separate liquid and staked)
    const liquidArioForCSV = arioDistributions.filter((d) => !d.isStaked);
    const stakedArioForCSV = arioDistributions.filter((d) => d.isStaked);

    // Liquid ARIO
    for (const dist of liquidArioForCSV) {
      const date = this.escapeCSVField(dist.date);
      const token = this.escapeCSVField("ARIO");
      const amount = dist.usdValues.ario
        ? this.escapeCSVField(dist.usdValues.ario.amount.toFixed(6))
        : this.escapeCSVField("0");
      const price = dist.usdValues.ario?.price
        ? this.escapeCSVField(dist.usdValues.ario.price.toFixed(4))
        : this.escapeCSVField("0");
      const usdValue = dist.usdValues.ario?.usdValue
        ? this.escapeCSVField(dist.usdValues.ario.usdValue.toFixed(8))
        : this.escapeCSVField("0");
      const stakingStatus = this.escapeCSVField("Liquid");

      rows.push(
        `${date},${token},${amount},${price},${usdValue},${stakingStatus}`,
      );
    }

    // Staked ARIO
    for (const dist of stakedArioForCSV) {
      const date = this.escapeCSVField(dist.date);
      const token = this.escapeCSVField("ARIO");
      const amount = dist.usdValues.ario
        ? this.escapeCSVField(dist.usdValues.ario.amount.toFixed(6))
        : this.escapeCSVField("0");
      const price = dist.usdValues.ario?.price
        ? this.escapeCSVField(dist.usdValues.ario.price.toFixed(4))
        : this.escapeCSVField("0");
      const usdValue = dist.usdValues.ario?.usdValue
        ? this.escapeCSVField(dist.usdValues.ario.usdValue.toFixed(8))
        : this.escapeCSVField("0");
      const stakingStatus = this.escapeCSVField("Staked");

      rows.push(
        `${date},${token},${amount},${price},${usdValue},${stakingStatus}`,
      );
    }

    // Process PIXL distributions
    for (const dist of pixlDistributions) {
      const date = this.escapeCSVField(dist.date);
      const token = this.escapeCSVField("PIXL");
      const amount = dist.usdValues.pixl
        ? this.escapeCSVField(dist.usdValues.pixl.amount.toFixed(6))
        : this.escapeCSVField("0");
      const price = dist.usdValues.pixl?.price
        ? this.escapeCSVField(dist.usdValues.pixl.price.toFixed(6))
        : this.escapeCSVField("0");
      const usdValue = dist.usdValues.pixl?.usdValue
        ? this.escapeCSVField(dist.usdValues.pixl.usdValue.toFixed(8))
        : this.escapeCSVField("0");
      const stakingStatus = this.escapeCSVField("Liquid"); // PIXL is always liquid

      rows.push(
        `${date},${token},${amount},${price},${usdValue},${stakingStatus}`,
      );
    }

    // Return CSV with only description, header, and data rows
    // All data rows have consistent 6 columns for proper CSV parsing
    return rows.join("\n");
  }

  async generateReport(
    walletAddress,
    startDate,
    endDate,
    includeStaked = false,
    options = {},
  ) {
    const currency = options.currency || "USD";
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
        `\n🚀 Generating CSV distribution report for wallet: ${walletAddress}`,
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
        return "";
      }

      const distributionsWithValues = await this.calculateValues(
        aoDistributions,
        piDistributions,
        arioDistributions,
        pixlDistributions,
        currency,
        fiatService,
      );

      const csv = this.generateCSV(
        walletAddress,
        startDate,
        endDate,
        distributionsWithValues,
        currency,
      );

      console.log(`✅ CSV generated successfully`);

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
          `   Total AO: ${totalAO.toFixed(12)} tokens (${currency} ${totalAOVal.toFixed(4)})`,
        );
      }
      if (totalPI > 0) {
        console.log(
          `   Total PI: ${totalPI.toFixed(12)} tokens (${currency} ${totalPIVal.toFixed(4)})`,
        );
      }
      if (totalARIO > 0) {
        console.log(
          `   Total ARIO (Liquid): ${totalARIO.toFixed(6)} tokens (${currency} ${totalARIOVal.toFixed(4)})`,
        );
      }
      if (totalStakedARIO > 0) {
        console.log(
          `   Total ARIO (Staked): ${totalStakedARIO.toFixed(6)} tokens`,
        );
      }
      if (totalPIXL > 0) {
        console.log(
          `   Total PIXL: ${totalPIXL.toFixed(6)} tokens (${currency} ${totalPIXLVal.toFixed(4)})`,
        );
      }
      console.log(
        `   Total Value: ${currency} ${(
          totalAOVal +
          totalPIVal +
          totalARIOVal +
          totalPIXLVal
        ).toFixed(4)}`,
      );

      return csv;
    } catch (error) {
      console.error("❌ CSV generation failed:", error.message);
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

module.exports = { WalletDistributionCSVGenerator, CONFIG };
