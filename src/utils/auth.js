/**
 * Authorization middleware
 * Checks if user is authorized for the requested service and year
 * Uses Cassandra cache and queries payment process if needed
 */

require("dotenv").config();
const cassandra = require("cassandra-driver");
const { types } = require("cassandra-driver");
const axios = require("axios");
const CONFIG = require("../../config/database");
const {
  CassandraArTrackerService,
} = require("../services/ar-tracker/CassandraArTrackerService");

// Payment process ID - should match the deployed process
const PAYMENT_PROCESS_ID =
  process.env.PAYMENT_PROCESS_ID ||
  "Oq9HJGXuKMRcAtpOZkM1gRlRIaL2FxP4UdK5tvNulro";

// When true, auth uses only Cassandra cache (and wallet groups for Full Tax). No AO/HyperBEAM calls.
const DISABLE_AO_PAYMENT_PROCESS =
  process.env.DISABLE_AO_PAYMENT_PROCESS !== "false";

// Cassandra configuration for subscriptions cache
const SUBSCRIPTION_DB = {
  contactPoints: ["localhost"],
  localDataCenter: "datacenter1",
  keyspace: "subscription_cache",
  pooling: {
    coreConnectionsPerHost: {
      [cassandra.types.distance.local]: 2,
      [cassandra.types.distance.remote]: 1,
    },
    maxConnectionsPerHost: {
      [cassandra.types.distance.local]: 4,
      [cassandra.types.distance.remote]: 2,
    },
  },
  socketOptions: {
    connectTimeout: 20000,
    readTimeout: 30000,
  },
};

let client = null;
let schemaInitialized = false;

// HyperBEAM URL for fetching process state
const HYPERBEAM_BASE_URL = "https://hyperbeam.permaweb.black";

/**
 * Convert Lua table notation to JSON
 * Handles: { ["key"] = value } -> { "key": value }
 *          { { item1 }, { item2 } } -> [ { item1 }, { item2 } ]
 *          key = value -> "key": value
 */
function luaTableToJson(luaStr) {
  if (!luaStr || typeof luaStr !== "string") {
    return luaStr;
  }

  let result = luaStr;

  // Replace ["key"] = with "key":
  result = result.replace(/\[["']([^"']+)["']\]\s*=/g, '"$1":');

  // Replace bare key = with "key": (but not inside strings)
  // Match word characters followed by = that aren't already quoted
  result = result.replace(/(\s)(\w+)\s*=/g, '$1"$2":');

  // Handle the start of the object for bare keys
  result = result.replace(/^\{\s*(\w+)\s*=/g, '{ "$1":');

  // Replace Lua array notation { { ... }, { ... } } with JSON array [ { ... }, { ... } ]
  // This is tricky - we need to detect when { } is used as an array vs object
  // A Lua array value looks like: "key": { { item }, { item } }
  // We need to convert the inner { { } } to [ { } ]

  // First pass: find patterns like ": { {" which indicate array start
  result = result.replace(/:\s*\{\s*\{/g, ": [ {");

  // Find closing } } that should be ] }
  // This is complex because we need to match balanced braces
  // Simple approach: replace } } followed by , or end of object
  result = result.replace(/\}\s*\}\s*(,|\})/g, "} ]$1");

  // Also handle } } at the very end
  result = result.replace(/\}\s*\}\s*$/g, "} ]");

  return result;
}

/**
 * Fetch subscriptions from HyperBEAM patch device
 * Returns the subscriptions object from the process state
 * No-op when DISABLE_AO_PAYMENT_PROCESS is set (no network call).
 */
async function fetchSubscriptionsFromHyperbeam() {
  if (DISABLE_AO_PAYMENT_PROCESS) return {};
  try {
    const url = `${HYPERBEAM_BASE_URL}/${PAYMENT_PROCESS_ID}~process@1.0/now/subscriptions`;

    const response = await axios.get(url, {
      timeout: 30000, // 30 second timeout (HyperBEAM can be slow)
      // Request as text to handle Lua format
      responseType: "text",
    });

    // The endpoint returns Lua table format, not JSON
    // We need to convert it
    let rawData = response.data;

    // If it's already parsed as an object (unlikely with responseType: text), return it
    if (typeof rawData === "object" && rawData !== null) {
      return rawData;
    }

    // Convert Lua table notation to JSON
    const jsonStr = luaTableToJson(rawData);

    try {
      const subscriptions = JSON.parse(jsonStr);

      if (!subscriptions || typeof subscriptions !== "object") {
        console.warn("HyperBEAM response invalid or empty after parsing");
        return {};
      }

      return subscriptions;
    } catch (parseError) {
      console.error("Failed to parse Lua table as JSON:", parseError.message);
      console.error("Raw data:", rawData.substring(0, 500));
      console.error("Converted:", jsonStr.substring(0, 500));
      return {};
    }
  } catch (error) {
    console.error(
      "Error fetching subscriptions from HyperBEAM:",
      error.message,
    );
    throw error;
  }
}

/**
 * Initialize Cassandra connection and create schema if needed
 */
async function initCassandra() {
  if (client && schemaInitialized) {
    return;
  }

  try {
    // Create client without keyspace first
    const clientConfig = { ...SUBSCRIPTION_DB };
    delete clientConfig.keyspace;
    client = new cassandra.Client(clientConfig);
    await client.connect();
    console.log("✅ Connected to Cassandra for subscription cache");

    // Create keyspace if it doesn't exist
    const keyspaceQuery = `
      CREATE KEYSPACE IF NOT EXISTS ${SUBSCRIPTION_DB.keyspace}
      WITH REPLICATION = {
        'class': 'SimpleStrategy',
        'replication_factor': 1
      }
    `;
    await client.execute(keyspaceQuery);
    console.log(`✅ Keyspace ${SUBSCRIPTION_DB.keyspace} ready`);

    // Switch to the keyspace
    await client.execute(`USE ${SUBSCRIPTION_DB.keyspace}`);

    // Create subscriptions table if it doesn't exist
    const tableQuery = `
      CREATE TABLE IF NOT EXISTS subscriptions (
        wallet text,
        service text,
        year text,
        subscribed boolean,
        subscribed_at bigint,
        cached_at timestamp,
        PRIMARY KEY ((wallet, service, year))
      )
    `;
    await client.execute(tableQuery);
    console.log("✅ Subscriptions table ready");

    // Referral tracking: referrer_id, payment_id, wallet/group, service, year, paid
    const referralTableQuery = `
      CREATE TABLE IF NOT EXISTS referral_tracking (
        referrer_id text,
        id timeuuid,
        payment_id text,
        wallet_id text,
        wallet_group_id text,
        created_at timestamp,
        service text,
        year text,
        paid boolean,
        PRIMARY KEY (referrer_id, id)
      )
    `;
    await client.execute(referralTableQuery);
    console.log("✅ Referral tracking table ready");

    schemaInitialized = true;
  } catch (error) {
    console.error("❌ Failed to initialize Cassandra:", error);
    throw error;
  }
}

/**
 * Extract wallet, service, and year from request
 * Supports multiple extraction methods:
 * - wallet: req.params.wallet, req.body.wallet, or req.headers['x-wallet']
 * - service: req.query.service, req.body.service, or req.headers['x-service'] (defaults to "Distribution Report")
 * - year: req.query.year, req.body.year, or req.headers['x-year'] (required; no default)
 */
function extractAuthParams(req) {
  const wallet =
    req.params?.wallet ||
    req.body?.wallet ||
    req.headers["x-wallet"] ||
    req.headers["wallet"];

  const service =
    req.query?.service ||
    req.body?.service ||
    req.headers["x-service"] ||
    req.headers["service"] ||
    "Distribution Report"; // Default service

  const yearStr =
    req.query?.year ??
    req.body?.year ??
    req.headers["x-year"] ??
    req.headers["year"];

  const year =
    yearStr !== undefined && yearStr !== null && yearStr !== ""
      ? parseInt(String(yearStr), 10)
      : NaN;

  return { wallet, service, year };
}

/**
 * Check if subscription exists in Cassandra cache
 */
async function checkCache(wallet, service, year) {
  if (!client) {
    await initCassandra();
  }

  try {
    // Convert year to string for query
    const yearString = String(year);
    const query = `
      SELECT subscribed, subscribed_at, cached_at
      FROM subscriptions
      WHERE wallet = ? AND service = ? AND year = ?
    `;
    const result = await client.execute(query, [wallet, service, yearString]);

    if (result.rows.length > 0) {
      const row = result.rows[0];
      return {
        cached: true,
        subscribed: row.subscribed,
        subscribedAt: row.subscribed_at,
        cachedAt: row.cached_at,
      };
    }

    return { cached: false };
  } catch (error) {
    console.error("Error checking cache:", error);
    return { cached: false, error };
  }
}

/**
 * Query payment process to check subscription status
 * Uses HyperBEAM to fetch subscriptions data
 * Falls back gracefully if HyperBEAM is unavailable
 * When DISABLE_AO_PAYMENT_PROCESS is set, returns not subscribed (no AO call).
 */
async function queryPaymentProcess(wallet, service, year) {
  if (DISABLE_AO_PAYMENT_PROCESS) return { subscribed: false };
  try {
    const subscriptions = await fetchSubscriptionsFromHyperbeam();

    // Check if wallet has subscriptions
    if (!subscriptions[wallet]) {
      return { subscribed: false };
    }

    // Look for the specific service:year subscription
    const walletSubs = subscriptions[wallet];
    // Convert year to string for comparison (matching Cassandra text schema)
    const yearString = String(year);
    const subscription = walletSubs.find((sub) => {
      // Compare as strings to match the new schema
      const subYearString = String(sub.year);
      return sub.service === service && subYearString === yearString;
    });

    if (!subscription) {
      return { subscribed: false };
    }

    // Convert stringified subscribedAt if needed
    const subscribedAt =
      typeof subscription.subscribedAt === "string"
        ? parseInt(subscription.subscribedAt, 10)
        : subscription.subscribedAt;

    return {
      subscribed: true,
      subscribedAt: subscribedAt,
    };
  } catch (error) {
    // Log but return false - let cache handle it if available
    if (error.code === "ECONNABORTED" || error.message.includes("timeout")) {
      console.warn(
        `HyperBEAM timeout checking subscription for ${wallet} - ${service} (${year}), will use cache if available`,
      );
    } else {
      console.error(
        "Error querying payment process via HyperBEAM:",
        error.message,
      );
    }
    return { subscribed: false, error: error.message };
  }
}

/**
 * Check if wallet has Full Tax Report for the given year (cache, HyperBEAM, or wallet group).
 * Used to authorize Distribution Report when Full Tax Report is held (included in purchase).
 */
async function hasFullTaxReportForYear(wallet, year) {
  const yearStr = String(year);

  const cacheResult = await checkCache(wallet, "Full Tax Report", year);
  if (cacheResult.cached && cacheResult.subscribed) return true;

  if (!DISABLE_AO_PAYMENT_PROCESS) {
    const paymentResult = await queryPaymentProcess(
      wallet,
      "Full Tax Report",
      year,
    );
    if (paymentResult.subscribed) return true;
  }

  let cassandraService = null;
  try {
    cassandraService = new CassandraArTrackerService();
    await cassandraService.connect();
    const groupsForWallet = await cassandraService.getGroupsForWallet(wallet);
    for (const { groupId } of groupsForWallet) {
      const group = await cassandraService.getWalletGroup(groupId);
      if (!group || !group.notes) continue;
      let notes;
      try {
        notes =
          typeof group.notes === "string"
            ? JSON.parse(group.notes)
            : group.notes;
      } catch (_) {
        continue;
      }
      if (!notes || typeof notes !== "object") continue;
      const svc = notes.service && String(notes.service).trim();
      const yr = notes.year != null ? String(notes.year) : null;
      if (svc === "Full Tax Report" && yr === yearStr) return true;
    }
    const allGroups = await cassandraService.getAllWalletGroups();
    const walletNorm = String(wallet).trim();
    for (const group of allGroups) {
      if (!group.wallets || !Array.isArray(group.wallets)) continue;
      const hasWallet = group.wallets.some(
        (w) => String(w).trim() === walletNorm,
      );
      if (!hasWallet) continue;
      let notes = null;
      try {
        notes =
          typeof group.notes === "string"
            ? JSON.parse(group.notes)
            : group.notes;
      } catch (_) {
        continue;
      }
      if (!notes || typeof notes !== "object") continue;
      const svc = notes.service && String(notes.service).trim();
      const yr = notes.year != null ? String(notes.year) : null;
      if (svc === "Full Tax Report" && yr === yearStr) return true;
    }
  } catch (err) {
    console.warn(
      "[auth] hasFullTaxReportForYear wallet group check failed:",
      err.message,
    );
  } finally {
    if (cassandraService) {
      try {
        await cassandraService.disconnect();
      } catch (_) {}
    }
  }
  return false;
}

/**
 * Normalize year value from a Cassandra row to a string (e.g. "2025").
 * The driver can return text columns as a number (big-endian ASCII: 842019381 === "2025").
 */
function yearFromRow(raw) {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  // Driver sometimes returns text as int (4-byte big-endian ASCII)
  if (typeof raw === "number" && raw >= 842006528 && raw <= 842082105) {
    return Buffer.from([
      (raw >>> 24) & 0xff,
      (raw >>> 16) & 0xff,
      (raw >>> 8) & 0xff,
      raw & 0xff,
    ]).toString("utf8");
  }
  if (
    typeof raw === "object" &&
    raw !== null &&
    typeof raw.toString === "function"
  ) {
    const s = raw.toString();
    const n = parseInt(s, 10);
    if (!isNaN(n) && n >= 842006528 && n <= 842082105) {
      return Buffer.from([
        (n >>> 24) & 0xff,
        (n >>> 16) & 0xff,
        (n >>> 8) & 0xff,
        n & 0xff,
      ]).toString("utf8");
    }
    return s;
  }
  return String(raw);
}

/**
 * Cache subscription result in Cassandra
 */
async function cacheSubscription(
  wallet,
  service,
  year,
  subscribed,
  subscribedAt,
) {
  if (!client) {
    await initCassandra();
  }

  try {
    const query = `
      INSERT INTO subscriptions (wallet, service, year, subscribed, subscribed_at, cached_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    const yearString = String(year);

    // Ensure subscribed_at is a Long (Cassandra bigint requires Long type)
    let subscribedAtLong = null;
    if (subscribedAt) {
      try {
        if (typeof subscribedAt === "bigint") {
          subscribedAtLong = types.Long.fromString(subscribedAt.toString());
        } else if (typeof subscribedAt === "string") {
          subscribedAtLong = types.Long.fromString(subscribedAt);
        } else {
          subscribedAtLong = types.Long.fromNumber(Number(subscribedAt));
        }
      } catch (err) {
        console.error(`❌ Invalid subscribed_at value: ${subscribedAt}`, err);
        subscribedAtLong = null;
      }
    }

    const params = [
      wallet,
      service,
      yearString,
      subscribed,
      subscribedAtLong,
      new Date(),
    ];

    await client.execute(query, params);
    console.log(
      `✅ Cached subscription: ${wallet} - ${service} (${yearString}) = ${subscribed}`,
    );
  } catch (error) {
    console.error("❌ Error caching subscription:", {
      error: error.message,
      wallet: wallet,
      service: service,
      year: year,
    });
    // Don't throw - caching failure shouldn't block authorization
  }
}

/**
 * Get all subscriptions for a wallet
 * Returns an array of {service, year} objects for active subscriptions
 */
async function getAllSubscriptions(wallet) {
  if (!wallet) {
    return [];
  }

  try {
    // Initialize Cassandra if needed
    await initCassandra();

    // First, check cache for all subscriptions for this wallet
    const cacheQuery = `
      SELECT service, year, subscribed, subscribed_at
      FROM subscriptions
      WHERE wallet = ?
      ALLOW FILTERING
    `;
    const cacheResult = await client.execute(cacheQuery, [wallet]);

    const subscriptions = [];
    const cachedSubscriptions = new Set(); // Track what we found in cache

    // Process cached results (validate year is a calendar year 2000-2100)
    for (const row of cacheResult.rows) {
      const yearString = yearFromRow(row.year);
      const yearNum = parseInt(yearString, 10);
      if (
        yearString === "" ||
        isNaN(yearNum) ||
        yearNum < 2000 ||
        yearNum > 2100
      ) {
        console.warn(
          `⚠️  Skipping invalid cached year: ${row.year} for wallet ${wallet}, service ${row.service}`,
        );
        continue;
      }
      const key = `${row.service}:${yearString}`;
      cachedSubscriptions.add(key);
      if (row.subscribed) {
        subscriptions.push({
          service: row.service,
          year: yearString,
          subscribedAt: row.subscribed_at,
          source: "cache",
        });
      }
    }

    // Query HyperBEAM for all subscriptions for this wallet (skipped when AO payment disabled)
    if (!DISABLE_AO_PAYMENT_PROCESS) {
      try {
        const allSubscriptions = await fetchSubscriptionsFromHyperbeam();

        // Get subscriptions for this specific wallet
        if (allSubscriptions[wallet]) {
          for (const sub of allSubscriptions[wallet]) {
            // Convert year to string for consistency (Cassandra stores as text)
            // Filter out invalid years (e.g., timestamps that were incorrectly stored)
            const yearString = String(sub.year);
            // Validate year is reasonable (between 2000 and 2100)
            const yearNum = parseInt(yearString, 10);
            if (isNaN(yearNum) || yearNum < 2000 || yearNum > 2100) {
              console.warn(
                `⚠️  Skipping invalid year value: ${sub.year} for wallet ${wallet}, service ${sub.service}`,
              );
              continue;
            }

            const subscribedAt =
              typeof sub.subscribedAt === "string"
                ? parseInt(sub.subscribedAt, 10)
                : sub.subscribedAt;

            const key = `${sub.service}:${yearString}`;
            // Only add if not already in cache or if cache says not subscribed
            if (!cachedSubscriptions.has(key)) {
              subscriptions.push({
                service: sub.service,
                year: yearString, // Store as string to match Cassandra schema
                subscribedAt: subscribedAt,
                source: "hyperbeam",
              });
              // Cache this result (year will be converted to string in cacheSubscription)
              await cacheSubscription(
                wallet,
                sub.service,
                yearString,
                true,
                subscribedAt,
              );
            }
          }
        }
      } catch (error) {
        // Log but don't fail - gracefully fall back to cache-only results
        if (
          error.code === "ECONNABORTED" ||
          error.message.includes("timeout")
        ) {
          console.warn(
            "HyperBEAM request timed out, using cached subscriptions only",
          );
        } else {
          console.error(
            "Error fetching subscriptions from HyperBEAM:",
            error.message,
          );
        }
        // Continue with cached results if HyperBEAM query fails
      }
    }

    // Sort by service, then year
    subscriptions.sort((a, b) => {
      if (a.service !== b.service) {
        return a.service.localeCompare(b.service);
      }
      return a.year - b.year;
    });

    return subscriptions;
  } catch (error) {
    console.error("Error getting all subscriptions:", error);
    return [];
  }
}

/**
 * Authorization middleware
 */
async function isAuthorized(req, res, next) {
  try {
    // Check for admin bypass code first
    const bypassCode =
      req.headers["x-auth-bypass"] ||
      req.headers["auth-bypass"] ||
      req.query?.authBypass ||
      req.body?.authBypass;

    const adminBypassCode = process.env.ADMIN_AUTH_BYPASS_CODE;

    if (adminBypassCode && bypassCode === adminBypassCode) {
      console.log(
        "🔓 Admin bypass code accepted - skipping authorization checks",
      );
      const { year } = extractAuthParams(req);
      if (year === undefined || year === null || isNaN(year)) {
        return res.status(400).json({
          error: "Missing year",
          message:
            "Year is required (provide via query, body, or X-Year header)",
        });
      }
      if (year < 2000 || year > 2100) {
        return res.status(400).json({
          error: "Invalid year",
          message: "Year must be a valid calendar year between 2000 and 2100",
          provided: year,
        });
      }
      req.authorizedYear = year;
      return next();
    }

    // Extract auth parameters from request
    const { wallet, service, year } = extractAuthParams(req);

    // Validate required parameters
    if (!wallet) {
      return res.status(400).json({
        error: "Missing wallet",
        message:
          "Wallet address is required (provide via params, body, or X-Wallet header)",
      });
    }

    if (!service) {
      return res.status(400).json({
        error: "Missing service",
        message:
          "Service name is required (provide via query, body, or X-Service header)",
      });
    }

    if (year === undefined || year === null || isNaN(year)) {
      return res.status(400).json({
        error: "Missing year",
        message: "Year is required (provide via query, body, or X-Year header)",
      });
    }
    if (year < 2000 || year > 2100) {
      return res.status(400).json({
        error: "Invalid year",
        message: "Year must be a valid calendar year between 2000 and 2100",
        provided: year,
      });
    }

    // Initialize Cassandra if needed
    await initCassandra();

    // Check cache first
    const cacheResult = await checkCache(wallet, service, year);

    if (cacheResult.cached) {
      // Use cached result
      if (cacheResult.subscribed) {
        console.log(`✅ Authorized (cached): ${wallet} - ${service} (${year})`);
        req.authorizedYear = year;
        return next();
      } else {
        if (service === "Distribution Report") {
          const hasFullTax = await hasFullTaxReportForYear(wallet, year);
          if (hasFullTax) {
            console.log(
              `✅ Authorized (cached): ${wallet} - ${service} (${year}) [included in Full Tax Report]`,
            );
            req.authorizedYear = year;
            return next();
          }
        }
        console.log(
          `❌ Unauthorized (cached): ${wallet} - ${service} (${year})`,
        );
        return res.status(403).json({
          error: "Forbidden",
          message: "You are not authorized to access this resource",
          wallet,
          service,
          year,
        });
      }
    }

    // Not in cache: when AO payment process is disabled, do not query it
    if (DISABLE_AO_PAYMENT_PROCESS) {
      // Distribution Report: allow if they have Full Tax Report for this year (cache or wallet group)
      if (service === "Distribution Report") {
        const hasFullTax = await hasFullTaxReportForYear(wallet, year);
        if (hasFullTax) {
          console.log(
            `✅ Authorized (cache miss, Full Tax): ${wallet} - ${service} (${year})`,
          );
          req.authorizedYear = year;
          return next();
        }
      }
      console.log(
        `❌ Unauthorized (cache miss, AO payment disabled): ${wallet} - ${service} (${year})`,
      );
      return res.status(403).json({
        error: "Forbidden",
        message: "You are not authorized to access this resource",
        wallet,
        service,
        year,
      });
    }

    console.log(
      `🔍 Querying payment process for: ${wallet} - ${service} (${year})`,
    );
    const paymentResult = await queryPaymentProcess(wallet, service, year);

    // Cache the result
    await cacheSubscription(
      wallet,
      service,
      year,
      paymentResult.subscribed,
      paymentResult.subscribedAt,
    );

    // Check authorization
    if (paymentResult.subscribed) {
      console.log(
        `✅ Authorized (payment process): ${wallet} - ${service} (${year})`,
      );
      req.authorizedYear = year;
      return next();
    } else {
      if (service === "Distribution Report") {
        const hasFullTax = await hasFullTaxReportForYear(wallet, year);
        if (hasFullTax) {
          console.log(
            `✅ Authorized (payment process): ${wallet} - ${service} (${year}) [included in Full Tax Report]`,
          );
          req.authorizedYear = year;
          return next();
        }
      }
      console.log(
        `❌ Unauthorized (payment process): ${wallet} - ${service} (${year})`,
      );
      return res.status(403).json({
        error: "Forbidden",
        message: "You are not authorized to access this resource",
        wallet,
        service,
        year,
      });
    }
  } catch (error) {
    console.error("Authorization error:", error);
    return res.status(500).json({
      error: "Internal server error",
      message: "Failed to verify authorization",
      details: error.message,
    });
  }
}

/**
 * Admin-only authorization middleware
 * Only checks for admin bypass code - no wallet/service/year required
 * Use this for admin endpoints like wallet group management
 */
async function isAdmin(req, res, next) {
  try {
    // Check for admin bypass code
    const bypassCode =
      req.headers["x-auth-bypass"] ||
      req.headers["auth-bypass"] ||
      req.query?.authBypass ||
      req.body?.authBypass;

    const adminBypassCode = process.env.ADMIN_AUTH_BYPASS_CODE;

    if (!adminBypassCode) {
      console.error("❌ ADMIN_AUTH_BYPASS_CODE not configured");
      return res.status(500).json({
        error: "Server configuration error",
        message: "Admin authentication not configured",
      });
    }

    if (!bypassCode) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Admin authentication required",
        hint: "Provide admin bypass code via X-Auth-Bypass header",
      });
    }

    if (bypassCode !== adminBypassCode) {
      console.warn(`❌ Invalid admin bypass code attempt`);
      return res.status(403).json({
        error: "Forbidden",
        message: "Invalid admin credentials",
      });
    }

    console.log("🔓 Admin access granted");
    return next();
  } catch (error) {
    console.error("Admin authorization error:", error);
    return res.status(500).json({
      error: "Internal server error",
      message: "Failed to verify admin authorization",
      details: error.message,
    });
  }
}

// ============================================================================
// REFERRAL TRACKING (subscription_cache.referral_tracking)
// ============================================================================

/**
 * Insert a referral record after successful payment.
 * @param {Object} params
 * @param {string} params.referrerId - Referrer identifier (from frontend)
 * @param {string} params.paymentId - Stripe session or payment_intent id
 * @param {string} params.walletId - Primary wallet address
 * @param {string|null} [params.walletGroupId] - Wallet group id if Full Tax
 * @param {string} params.service - e.g. "Distribution Report"
 * @param {string} params.year - e.g. "2025"
 * @returns {Promise<{ id: string }>}
 */
async function insertReferral({
  referrerId,
  paymentId,
  walletId,
  walletGroupId,
  service,
  year,
}) {
  const normalizedReferrerId =
    referrerId != null ? String(referrerId).trim().toLowerCase() : "";
  if (!normalizedReferrerId) return { id: null };
  if (!client) await initCassandra();
  const id = types.TimeUuid.now();
  const createdAt = new Date();
  await client.execute(
    `INSERT INTO referral_tracking (referrer_id, id, payment_id, wallet_id, wallet_group_id, created_at, service, year, paid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, false)`,
    [
      normalizedReferrerId,
      id,
      paymentId,
      walletId,
      walletGroupId || null,
      createdAt,
      service,
      year,
    ],
  );
  return { id: id.toString() };
}

/**
 * List referral records by referrer id (admin).
 * @param {string} referrerId
 * @returns {Promise<Array<{ id: string, paymentId: string, walletId: string, walletGroupId: string|null, createdAt: Date, service: string, year: string, paid: boolean }>>}
 */
async function getReferralsByReferrerId(referrerId) {
  const normalized =
    referrerId != null ? String(referrerId).trim().toLowerCase() : "";
  if (!client) await initCassandra();
  const result = await client.execute(
    `SELECT id, payment_id, wallet_id, wallet_group_id, created_at, service, year, paid
     FROM referral_tracking WHERE referrer_id = ? ORDER BY id DESC`,
    [normalized],
    { prepare: true },
  );
  return result.rows.map((row) => ({
    id: row.id.toString(),
    paymentId: row.payment_id,
    walletId: row.wallet_id,
    walletGroupId: row.wallet_group_id,
    createdAt: row.created_at,
    service: row.service,
    year: row.year,
    paid: row.paid === true,
  }));
}

/**
 * Update paid flag for a specific referral (admin).
 * @param {string} referrerId
 * @param {string} id - timeuuid string of the referral row
 * @param {boolean} paid
 */
async function updateReferralPaid(referrerId, id, paid) {
  const normalized =
    referrerId != null ? String(referrerId).trim().toLowerCase() : "";
  if (!client) await initCassandra();
  const idUuid = types.Uuid.fromString(id);
  await client.execute(
    `UPDATE referral_tracking SET paid = ? WHERE referrer_id = ? AND id = ?`,
    [paid, normalized, idUuid],
    { prepare: true },
  );
}

module.exports = {
  isAuthorized,
  isAdmin,
  getAllSubscriptions,
  initCassandra,
  cacheSubscription,
  insertReferral,
  getReferralsByReferrerId,
  updateReferralPaid,
};
