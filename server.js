#!/usr/bin/env node

require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const {
  isAuthorized,
  isAdmin,
  getAllSubscriptions,
  cacheSubscription,
  getReferralsByReferrerId,
  updateReferralPaid,
} = require("./src/utils/auth");
const cassandra = require("cassandra-driver");
const CONFIG = require("./config/database");

// Import PDF generator service
const {
  WalletDistributionPDFGenerator,
} = require("./src/services/wallet_distribution_pdf_generator");

// Import CSV generator service
const {
  WalletDistributionCSVGenerator,
} = require("./src/services/wallet_distribution_csv_generator");

// ============================================================================
// AR TRACKER IMPORTS
// ============================================================================

// AR Tracker services
const {
  CassandraArTrackerService,
} = require("./src/services/ar-tracker/CassandraArTrackerService");
const {
  CostBasisService,
} = require("./src/services/ar-tracker/CostBasisService");
const { PriceService } = require("./src/services/ar-tracker/PriceService");
const {
  FiatConversionService,
} = require("./src/services/ar-tracker/FiatConversionService");
const {
  UnifiedWalletHistoryService,
} = require("./src/services/ar-tracker/UnifiedWalletHistoryService");
const {
  DistributionService,
} = require("./src/services/ar-tracker/DistributionService");
const {
  TaxReportGenerator,
} = require("./src/services/ar-tracker/TaxReportGenerator");
const {
  BazarProfileService,
} = require("./src/services/ar-tracker/BazarProfileService");
const { DEXPriceIndexer } = require("./src/indexers/dex_price_indexer");

// Import honeypot middleware for catching malicious bots
const {
  honeypotMiddleware,
  getAttackerLog,
  getAttackerStats,
} = require("./src/middleware/honeypot");
const {
  stripeWebhookHandler,
  createCheckoutSessionHandler,
} = require("./src/services/stripePaymentHandler");
const { runWalletGroupIndexing } = require("./src/services/walletGroupIndexer");

// Import schema initialization
const {
  initializeArTrackerSchema,
} = require("./admin-utilities/init-ar-tracker-schema");

// ============================================================================
// JOB STATUS TRACKING
// ============================================================================

// In-memory job status tracking
const jobStatus = {
  "update-all": {
    status: "idle", // idle, running, completed, error
    startTime: null,
    endTime: null,
    duration: null,
    lastError: null,
    lastSuccess: null,
    steps: [],
  },
  "update-ao-distributions": {
    status: "idle",
    startTime: null,
    endTime: null,
    duration: null,
    lastError: null,
    lastSuccess: null,
  },
  "update-pi-distributions": {
    status: "idle",
    startTime: null,
    endTime: null,
    duration: null,
    lastError: null,
    lastSuccess: null,
  },
  "update-ario-distributions": {
    status: "idle",
    startTime: null,
    endTime: null,
    duration: null,
    lastError: null,
    lastSuccess: null,
  },
  "update-ario-gateway-mainnet": {
    status: "idle",
    startTime: null,
    endTime: null,
    duration: null,
    lastError: null,
    lastSuccess: null,
  },
  "update-ao-prices": {
    status: "idle",
    startTime: null,
    endTime: null,
    duration: null,
    lastError: null,
    lastSuccess: null,
  },
  "update-ario-prices": {
    status: "idle",
    startTime: null,
    endTime: null,
    duration: null,
    lastError: null,
    lastSuccess: null,
  },
  "update-permaswap-prices": {
    status: "idle",
    startTime: null,
    endTime: null,
    duration: null,
    lastError: null,
    lastSuccess: null,
  },
  "test-job": {
    status: "idle",
    startTime: null,
    endTime: null,
    duration: null,
    lastError: null,
    lastSuccess: null,
  },
  // Individual indexer and fetcher jobs
  "ao-distributions": {
    status: "idle",
    startTime: null,
    endTime: null,
    duration: null,
    lastError: null,
    lastSuccess: null,
  },
  "pi-distributions": {
    status: "idle",
    startTime: null,
    endTime: null,
    duration: null,
    lastError: null,
    lastSuccess: null,
  },
  "ario-distributions": {
    status: "idle",
    startTime: null,
    endTime: null,
    duration: null,
    lastError: null,
    lastSuccess: null,
  },
  "ario-gateway-mainnet": {
    status: "idle",
    startTime: null,
    endTime: null,
    duration: null,
    lastError: null,
    lastSuccess: null,
  },
  "pixl-distributions": {
    status: "idle",
    startTime: null,
    endTime: null,
    duration: null,
    lastError: null,
    lastSuccess: null,
  },
  "ao-prices": {
    status: "idle",
    startTime: null,
    endTime: null,
    duration: null,
    lastError: null,
    lastSuccess: null,
  },
  "ario-prices": {
    status: "idle",
    startTime: null,
    endTime: null,
    duration: null,
    lastError: null,
    lastSuccess: null,
  },
  "pi-prices": {
    status: "idle",
    startTime: null,
    endTime: null,
    duration: null,
    lastError: null,
    lastSuccess: null,
  },
  "ar-prices": {
    status: "idle",
    startTime: null,
    endTime: null,
    duration: null,
    lastError: null,
    lastSuccess: null,
  },
  // AR Tracker jobs
  "dex-price-indexer": {
    status: "idle",
    startTime: null,
    endTime: null,
    duration: null,
    lastError: null,
    lastSuccess: null,
  },
  "fiat-rate-indexer": {
    status: "idle",
    startTime: null,
    endTime: null,
    duration: null,
    lastError: null,
    lastSuccess: null,
  },
  "wallet-sync": {
    status: "idle",
    startTime: null,
    endTime: null,
    duration: null,
    lastError: null,
    lastSuccess: null,
  },
  "wallet-report": {
    status: "idle",
    startTime: null,
    endTime: null,
    duration: null,
    lastError: null,
    lastSuccess: null,
  },
};

// Helper function to update job status
function updateJobStatus(jobName, status, error = null, step = null) {
  const now = new Date();

  if (status === "running") {
    jobStatus[jobName].status = "running";
    jobStatus[jobName].startTime = now.toISOString();
    jobStatus[jobName].endTime = null;
    jobStatus[jobName].duration = null;
    if (step) {
      jobStatus[jobName].steps.push({
        step,
        startTime: now.toISOString(),
        status: "running",
      });
    }
  } else if (status === "completed") {
    jobStatus[jobName].status = "completed";
    jobStatus[jobName].endTime = now.toISOString();
    jobStatus[jobName].duration = jobStatus[jobName].startTime
      ? Math.round((now - new Date(jobStatus[jobName].startTime)) / 1000)
      : null;
    jobStatus[jobName].lastSuccess = now.toISOString();
    jobStatus[jobName].lastError = null;
    if (step) {
      const stepIndex = jobStatus[jobName].steps.findIndex(
        (s) => s.step === step,
      );
      if (stepIndex >= 0) {
        jobStatus[jobName].steps[stepIndex].status = "completed";
        jobStatus[jobName].steps[stepIndex].endTime = now.toISOString();
        jobStatus[jobName].steps[stepIndex].duration = Math.round(
          (now - new Date(jobStatus[jobName].steps[stepIndex].startTime)) /
            1000,
        );
      }
    }
  } else if (status === "error") {
    jobStatus[jobName].status = "error";
    jobStatus[jobName].endTime = now.toISOString();
    jobStatus[jobName].duration = jobStatus[jobName].startTime
      ? Math.round((now - new Date(jobStatus[jobName].startTime)) / 1000)
      : null;
    jobStatus[jobName].lastError = {
      message: error?.message || "Unknown error",
      timestamp: now.toISOString(),
      details: error?.stdout || error?.stderr || null,
    };
    if (step) {
      const stepIndex = jobStatus[jobName].steps.findIndex(
        (s) => s.step === step,
      );
      if (stepIndex >= 0) {
        jobStatus[jobName].steps[stepIndex].status = "error";
        jobStatus[jobName].steps[stepIndex].endTime = now.toISOString();
        jobStatus[jobName].steps[stepIndex].duration = Math.round(
          (now - new Date(jobStatus[jobName].steps[stepIndex].startTime)) /
            1000,
        );
        jobStatus[jobName].steps[stepIndex].error =
          error?.message || "Unknown error";
      }
    }
  }
}

// Wallet addresses currently being synced (per-wallet; different wallets can sync in parallel)
const walletSyncInProgress = new Set();

// ============================================================================
// WALLET HELPERS
// ============================================================================

/**
 * Normalize wallet input to array
 * Accepts: single wallet string or array of wallets
 * @param {string|string[]} wallet - Single wallet or array of wallets
 * @param {string[]} wallets - Alternative array parameter
 * @returns {{ wallets: string[], primaryWallet: string }} Normalized wallet data
 */
function normalizeWalletInput(wallet, wallets) {
  // Prefer wallets array if provided
  if (Array.isArray(wallets) && wallets.length > 0) {
    const uniqueWallets = [...new Set(wallets)];
    return {
      wallets: uniqueWallets,
      primaryWallet: uniqueWallets[0],
    };
  }

  // If wallet is already an array
  if (Array.isArray(wallet)) {
    const uniqueWallets = [...new Set(wallet)];
    return {
      wallets: uniqueWallets,
      primaryWallet: uniqueWallets[0],
    };
  }

  // Single wallet string
  if (typeof wallet === "string" && wallet.length > 0) {
    return {
      wallets: [wallet],
      primaryWallet: wallet,
    };
  }

  return { wallets: [], primaryWallet: null };
}

/**
 * Validate Arweave address format
 * @param {string} address - Address to validate
 * @returns {boolean}
 */
function isValidArweaveAddress(address) {
  if (typeof address !== "string") return false;
  return /^[A-Za-z0-9_-]{43}$/.test(address.trim());
}

/**
 * Validate array of wallet addresses
 * @param {string[]} wallets - Array of wallet addresses
 * @returns {{ valid: boolean, invalid: string[] }}
 */
function validateWallets(wallets) {
  const invalid = wallets.filter((w) => !isValidArweaveAddress(w));
  return {
    valid: invalid.length === 0,
    invalid,
  };
}

/**
 * Run wallet sync: set group status to "indexing", fetch history, then set "active" or "error".
 * Caller must add wallets to walletSyncInProgress before calling and remove in finally.
 * @param {string[]} wallets
 * @param {{ fullHistory?: boolean }} options
 * @returns {Promise<{ results: object }>}
 */
async function runWalletSync(wallets, options = {}) {
  const { fullHistory = false } = options;
  const cassandraService = new CassandraArTrackerService();
  await cassandraService.connect();
  const groupIds = new Set();
  try {
    for (const w of wallets) {
      const groups = await cassandraService.getGroupsForWallet(w);
      for (const g of groups) groupIds.add(g.groupId);
    }
    for (const groupId of groupIds) {
      await cassandraService.updateWalletGroup(groupId, {
        status: "indexing",
      });
    }
    const historyService = new UnifiedWalletHistoryService({
      cassandraService,
      fullHistory,
    });
    const results = await historyService.fetchCompleteHistory(wallets, {
      fullHistory,
    });
    for (const groupId of groupIds) {
      try {
        await cassandraService.updateWalletGroup(groupId, {
          status: "active",
          lastIndexedAt: new Date(),
          lastIndexStatus: "completed",
          lastIndexError: null,
          transactionCount: results.unified?.length || 0,
        });
      } catch (e) {
        console.warn(`Could not update wallet group ${groupId}:`, e.message);
      }
    }
    await cassandraService.disconnect();
    return { results };
  } catch (error) {
    for (const groupId of groupIds) {
      try {
        await cassandraService.updateWalletGroup(groupId, {
          status: "error",
          lastIndexError: error?.message || "Sync failed",
        });
      } catch (_) {}
    }
    await cassandraService.disconnect().catch(() => {});
    throw error;
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// CORS middleware - Allow all origins for permaweb compatibility
// Permaweb sites can be served from any of 650+ gateway domains
app.use((req, res, next) => {
  const origin = req.headers.origin;

  // Allow all origins (permaweb sites can be served from any gateway domain)
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Wallet, X-Service, X-Year, X-Auth-Bypass",
  );
  res.setHeader("Access-Control-Allow-Credentials", "true");

  // Handle preflight requests
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

// Stripe webhook must receive raw body for signature verification (mount before express.json())
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  stripeWebhookHandler,
);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Stripe create-checkout-session (JSON body; used by frontend to get checkout URL)
app.post("/api/stripe/create-checkout-session", createCheckoutSessionHandler);

// Honeypot middleware - catch malicious bots BEFORE logging
// This serves fake credentials to scanners and logs their IPs
app.use(honeypotMiddleware);

// Logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

/**
 * Get all subscriptions for a wallet
 * GET /api/subscriptions/:wallet
 * This endpoint is NOT auth-restricted - it's for checking subscription status.
 * Includes subscriptions where this wallet is the primary wallet (cache/HyperBEAM)
 * and subscriptions where this wallet is any member of a wallet group (Full Tax Report).
 * When a subscription comes from a wallet group, wallet_group_id is set for use in report API calls.
 */
app.get("/api/subscriptions/:wallet", async (req, res) => {
  try {
    const { wallet } = req.params;

    if (!wallet) {
      return res.status(400).json({
        error: "Missing wallet",
        message: "Wallet address is required",
      });
    }

    console.log(`🔍 Getting all subscriptions for wallet: ${wallet}`);

    // 1) Subscriptions from cache + HyperBEAM (primary or per-wallet)
    const fromAuth = await getAllSubscriptions(wallet);
    const byKey = new Map();
    for (const sub of fromAuth) {
      const key = `${sub.service}:${sub.year}`;
      byKey.set(key, {
        service: sub.service,
        year: sub.year,
        subscribedAt: sub.subscribedAt,
        wallet_group_id: sub.wallet_group_id || undefined,
      });
    }

    // 2) Subscriptions from wallet groups: any group that contains this wallet
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
        const service = notes.service && String(notes.service).trim();
        const year = notes.year != null ? String(notes.year) : null;
        if (!service || !year) continue;
        const key = `${service}:${year}`;
        const subscribedAt =
          group.createdAt && typeof group.createdAt.getTime === "function"
            ? Math.floor(group.createdAt.getTime() / 1000)
            : undefined;
        const indexStatus = group.status || "pending"; // pending | indexing | active | error
        if (byKey.has(key)) {
          const existing = byKey.get(key);
          if (!existing.wallet_group_id) {
            existing.wallet_group_id = groupId;
            existing.index_status = indexStatus;
          }
        } else {
          byKey.set(key, {
            service,
            year,
            subscribedAt,
            wallet_group_id: groupId,
            index_status: indexStatus,
          });
        }
      }

      // Fallback: Full Tax Report subscriptions from cache may lack wallet_group_id if
      // wallet_to_groups wasn't populated (e.g. group created before that table existed).
      // Resolve by finding a registered_wallet_groups row where this wallet is in wallets and notes match.
      for (const [key, sub] of byKey.entries()) {
        if (
          sub.service === "Full Tax Report" &&
          !sub.wallet_group_id &&
          cassandraService
        ) {
          try {
            const allGroups = await cassandraService.getAllWalletGroups();
            const yearStr = String(sub.year);
            const walletNorm = String(wallet).trim();
            for (const group of allGroups) {
              const walletsList = group.wallets;
              if (!walletsList || !Array.isArray(walletsList)) continue;
              const hasWallet = walletsList.some(
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
              if (svc === "Full Tax Report" && yr === yearStr) {
                sub.wallet_group_id = group.groupId;
                sub.index_status = group.status || "pending";
                break;
              }
            }
          } catch (fallbackErr) {
            console.warn(
              "Subscriptions fallback (resolve Full Tax group):",
              fallbackErr.message,
            );
          }
        }
      }

      // Single-wallet Full Tax (no group): derive index_status; if pending and valid subscription, trigger sync
      const singleWalletFullTax = Array.from(byKey.values()).filter(
        (s) => s.service === "Full Tax Report" && !s.wallet_group_id,
      );
      if (singleWalletFullTax.length > 0 && cassandraService) {
        try {
          if (walletSyncInProgress.has(wallet)) {
            for (const sub of singleWalletFullTax)
              sub.index_status = "indexing";
          } else {
            const hasData = await cassandraService.walletHasIndexedData(wallet);
            const status = hasData ? "active" : "pending";
            for (const sub of singleWalletFullTax) sub.index_status = status;
            if (status === "pending") {
              walletSyncInProgress.add(wallet);
              runWalletSync([wallet], { fullHistory: false })
                .catch((err) =>
                  console.warn(
                    "Subscription-triggered sync failed:",
                    err?.message || err,
                  ),
                )
                .finally(() => walletSyncInProgress.delete(wallet));
              for (const sub of singleWalletFullTax)
                sub.index_status = "indexing";
            }
          }
        } catch (e) {
          console.warn("Subscriptions single-wallet index check:", e.message);
          for (const sub of singleWalletFullTax) sub.index_status = "pending";
        }
      }
    } catch (err) {
      console.warn(
        "Error fetching subscriptions from wallet groups:",
        err.message,
      );
    } finally {
      if (cassandraService) {
        try {
          await cassandraService.disconnect();
        } catch (_) {}
      }
    }

    // Distribution Report is included with Full Tax Report: add synthetic Distribution Report
    // for each year the wallet has Full Tax Report so the frontend can offer both report types.
    for (const sub of Array.from(byKey.values())) {
      if (sub.service === "Full Tax Report") {
        const distKey = `Distribution Report:${sub.year}`;
        if (!byKey.has(distKey)) {
          byKey.set(distKey, {
            service: "Distribution Report",
            year: sub.year,
            subscribedAt: sub.subscribedAt,
          });
        }
      }
    }

    const subscriptions = Array.from(byKey.values()).sort((a, b) => {
      if (a.service !== b.service) return a.service.localeCompare(b.service);
      return String(a.year).localeCompare(String(b.year));
    });

    res.json({
      wallet,
      subscriptions: subscriptions.map((sub) => {
        const out = {
          service: sub.service,
          year: sub.year,
          subscribedAt: sub.subscribedAt,
        };
        if (sub.wallet_group_id) {
          out.wallet_group_id = sub.wallet_group_id;
          if (sub.index_status) out.index_status = sub.index_status;
        } else if (sub.service === "Full Tax Report" && !sub.wallet_group_id) {
          // Single-wallet Full Tax: use computed status or "pending" if check failed
          out.index_status = sub.index_status || "pending";
        }
        return out;
      }),
      count: subscriptions.length,
    });
  } catch (error) {
    console.error("Error getting subscriptions:", error);
    res.status(500).json({
      error: "Failed to get subscriptions",
      message: error.message,
    });
  }
});

/**
 * Status endpoint - shows all job statuses
 * GET /api/status
 */
app.get("/api/status", (req, res) => {
  try {
    const now = new Date();
    const status = {
      server: {
        status: "running",
        uptime: process.uptime(),
        timestamp: now.toISOString(),
        memory: process.memoryUsage(),
        version: process.version,
      },
      jobs: {},
    };

    // Add each job status
    Object.keys(jobStatus).forEach((jobName) => {
      const job = jobStatus[jobName];
      status.jobs[jobName] = {
        status: job.status,
        startTime: job.startTime,
        endTime: job.endTime,
        duration: job.duration,
        lastSuccess: job.lastSuccess,
        lastError: job.lastError,
        steps: job.steps || null,
      };
    });

    res.json(status);
  } catch (error) {
    console.error("Error getting status:", error);
    res.status(500).json({
      error: "Failed to get status",
      message: error.message,
    });
  }
});

// API Info endpoint
app.get("/", (req, res) => {
  res.json({
    name: "AO Tax Tracker Server",
    version: "1.0.0",
    description:
      "HTTP API for AO and PI token distributions with price data and PDF generation for tax tracking",
    endpoints: {
      health: "GET /health",
      subscriptions: {
        getAll: "GET /api/subscriptions/:wallet",
      },
      distributions: {
        generatePDF:
          "POST /api/distributions/pdf { wallet, includeStaked?, currency? } — date range from x-year",
        generateCSV:
          "POST /api/distributions/csv { wallet, includeStaked?, currency? } — date range from x-year",
        getByWallet:
          "GET /api/distributions/:wallet — date range from x-year (query params ignored)",
        getRejectedCSVs: "GET /api/rejected-csvs?format=simple|detailed|stats",
      },
      prices: {
        getByToken: "GET /api/prices/:token",
        getByDate: "GET /api/prices/:token/:date",
      },
      walletReports: {
        sync: "POST /api/wallet/sync { wallet|wallets, fullHistory? } - Multi-wallet support (max 5)",
        transactions: "GET /api/wallet/transactions/:wallet",
        generatePDF:
          "POST /api/wallet-report/pdf { wallet|wallets, taxYear, accountingMethod?, currency? }",
        generateCSV:
          "POST /api/wallet-report/csv { wallet|wallets, taxYear, reportType?, currency? }",
        summary: "GET /api/wallet-report/summary/:wallet/:taxYear",
      },
      dexPrices: {
        getPrice: "GET /api/dex-prices/:token",
        getPriceByDate: "GET /api/dex-prices/:token/:date",
      },
      fiatConversion: {
        convert: "GET /api/fiat-conversion/:amount/:currency/:date?",
      },
      jobs: {
        updateDistributions:
          "POST /api/jobs/update-distributions { forceReprocess?: boolean }",
        updateAoDistributions:
          "POST /api/jobs/update-ao-distributions { forceReprocess?: boolean }",
        updatePiDistributions:
          "POST /api/jobs/update-pi-distributions { forceReprocess?: boolean }",
        updatePixlDistributions:
          "POST /api/jobs/pixl-distributions { full?: boolean, clear?: boolean, verify?: boolean }",
        updatePrices: "POST /api/jobs/update-prices",
        updateArioDistributions: "POST /api/jobs/update-ario-distributions",
        updateArioPrices: "POST /api/jobs/update-ario-prices",
        updateAll: "POST /api/jobs/update-all { forceReprocess?: boolean }",
        indexArioTestnet: "POST /api/jobs/index-ario-testnet (one-time use)",
        dexPriceIndexer: "POST /api/jobs/dex-price-indexer { incremental? }",
        fiatRateIndexer: "POST /api/jobs/fiat-rate-indexer { incremental? }",
        testJob: "POST /api/jobs/test-job",
      },
    },
  });
});

// ============================================================================
// DISTRIBUTION ENDPOINTS
// ============================================================================

/**
 * Generate PDF for wallet distributions
 * POST /api/distributions/pdf
 * Body: { wallet: string, includeStaked?: boolean, currency?: string }
 * Date range is derived from authorized year (x-year); client-provided dates are ignored.
 */
app.post("/api/distributions/pdf", isAuthorized, async (req, res) => {
  // Set extended timeout for this specific request (10 minutes)
  // PDF generation with staked tokens requires fetching epoch data which can take several minutes
  req.setTimeout(600000); // 10 minutes
  res.setTimeout(600000); // 10 minutes

  try {
    const { wallet, includeStaked = false, currency = "USD" } = req.body;

    if (!wallet) {
      return res.status(400).json({
        error: "Missing required parameters",
        required: ["wallet"],
      });
    }

    const year = req.authorizedYear;
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    console.log(
      `📄 Generating PDF for wallet ${wallet} (${startDate} to ${endDate})${
        includeStaked ? " [including staked]" : ""
      }${currency !== "USD" ? ` [${currency}]` : ""}`,
    );

    const generator = new WalletDistributionPDFGenerator();

    // Generate a unique filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `wallet-${wallet.substring(
      0,
      8,
    )}-${startDate}-to-${endDate}-${timestamp}.pdf`;
    const pdfPath = path.join(__dirname, filename);

    await generator.generateReport(
      wallet,
      startDate,
      endDate,
      pdfPath,
      includeStaked,
      { currency },
    );

    // Read the PDF file
    const pdfBuffer = fs.readFileSync(pdfPath);

    // Set headers for PDF download
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${path.basename(pdfPath)}"`,
    );
    res.setHeader("Content-Length", pdfBuffer.length);

    // Send the PDF
    res.send(pdfBuffer);

    // Clean up the temporary PDF file
    fs.unlinkSync(pdfPath);
  } catch (error) {
    console.error("Error generating PDF:", error);
    res.status(500).json({
      error: "Failed to generate PDF",
      message: error.message,
    });
  }
});

/**
 * Generate CSV for wallet distributions
 * POST /api/distributions/csv
 * Body: { wallet: string, includeStaked?: boolean, currency?: string }
 * Date range is derived from authorized year (x-year); client-provided dates are ignored.
 */
app.post("/api/distributions/csv", isAuthorized, async (req, res) => {
  // Set extended timeout for this specific request (10 minutes)
  // CSV generation with staked tokens requires fetching epoch data which can take several minutes
  req.setTimeout(600000); // 10 minutes
  res.setTimeout(600000); // 10 minutes

  try {
    const { wallet, includeStaked = false, currency = "USD" } = req.body;

    if (!wallet) {
      return res.status(400).json({
        error: "Missing required parameters",
        required: ["wallet"],
      });
    }

    const year = req.authorizedYear;
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    console.log(
      `📄 Generating CSV for wallet ${wallet} (${startDate} to ${endDate})${
        includeStaked ? " [including staked]" : ""
      }`,
    );

    const generator = new WalletDistributionCSVGenerator();

    const csv = await generator.generateReport(
      wallet,
      startDate,
      endDate,
      includeStaked,
      { currency },
    );

    if (!csv) {
      return res.status(404).json({
        error: "No distributions found",
        message:
          "No distributions found for the specified wallet and date range",
      });
    }

    // Set headers for CSV download
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${startDate}-Taxable-Distribution-Report-${wallet.substring(
        0,
        8,
      )}-${wallet.substring(wallet.length - 4)}.csv"`,
    );

    // Send the CSV
    res.send(csv);
  } catch (error) {
    console.error("Error generating CSV:", error);
    res.status(500).json({
      error: "Failed to generate CSV",
      message: error.message,
    });
  }
});

/**
 * Get distributions for a wallet
 * GET /api/distributions/:wallet
 * Date range is derived from authorized year (x-year); query startDate/endDate are ignored.
 */
app.get("/api/distributions/:wallet", isAuthorized, async (req, res) => {
  try {
    const { wallet } = req.params;
    const year = req.authorizedYear;
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    // Connect to all distribution databases
    const aoClient = new cassandra.Client(CONFIG.AO_DISTRIBUTION_DB);
    const piClient = new cassandra.Client(CONFIG.PI_DISTRIBUTION_DB);
    const pixlClient = new cassandra.Client(CONFIG.AR_TAX_TRACKER_DB);

    await aoClient.connect();
    await piClient.connect();
    await pixlClient.connect();

    // Query AO distributions
    const aoQuery = `
      SELECT * FROM distributions
      WHERE address = ? AND date >= ? AND date <= ?
      ALLOW FILTERING
    `;
    const aoResult = await aoClient.execute(aoQuery, [
      wallet,
      startDate,
      endDate,
    ]);

    // Query PI distributions
    const piQuery = `
      SELECT * FROM distributions
      WHERE address = ? AND date >= ? AND date <= ?
      ALLOW FILTERING
    `;
    const piResult = await piClient.execute(piQuery, [
      wallet,
      startDate,
      endDate,
    ]);

    // Query PIXL distributions
    const pixlQuery = `
      SELECT wallet_address, distribution_block, distribution_timestamp,
             run_rewards_tx_id, amount_units, amount_human, streak_days
      FROM pixl_distributions
      WHERE wallet_address = ?
    `;
    const pixlResult = await pixlClient.execute(pixlQuery, [wallet]);

    // Filter PIXL by date range
    const startDateObj = new Date(startDate);
    const endDateObj = new Date(endDate);
    endDateObj.setHours(23, 59, 59, 999); // Include full end date

    const filteredPixl = pixlResult.rows.filter((row) => {
      if (!row.distribution_timestamp) return false;
      const rowDate = new Date(row.distribution_timestamp);
      return rowDate >= startDateObj && rowDate <= endDateObj;
    });

    await aoClient.shutdown();
    await piClient.shutdown();
    await pixlClient.shutdown();

    res.json({
      wallet,
      startDate,
      endDate,
      distributions: {
        ao: aoResult.rows.map((row) => ({
          date: row.date,
          amount: row.amount_units,
          txid: row.txid,
          source_txid: row.source_txid,
        })),
        pi: piResult.rows.map((row) => ({
          date: row.date,
          amount: row.amount_units,
          txid: row.txid,
          source_txid: row.source_txid,
        })),
        pixl: filteredPixl.map((row) => ({
          date: row.distribution_timestamp
            ? new Date(row.distribution_timestamp).toISOString().split("T")[0]
            : null,
          block: row.distribution_block,
          amount: row.amount_units,
          amount_human: row.amount_human,
          txid: row.run_rewards_tx_id,
          streak_days: row.streak_days,
        })),
      },
      counts: {
        ao: aoResult.rows.length,
        pi: piResult.rows.length,
        pixl: filteredPixl.length,
        total:
          aoResult.rows.length + piResult.rows.length + filteredPixl.length,
      },
    });
  } catch (error) {
    console.error("Error fetching distributions:", error);
    res.status(500).json({
      error: "Failed to fetch distributions",
      message: error.message,
    });
  }
});

/**
 * Get rejected CSV transaction IDs
 * GET /api/rejected-csvs?format=simple|detailed|stats
 */
app.get("/api/rejected-csvs", isAuthorized, async (req, res) => {
  try {
    const { format = "simple" } = req.query;

    console.log("🔍 Checking for rejected AO CSV files...");

    const RejectedCSVChecker = require("./scripts/check-rejected-csvs");
    const checker = new RejectedCSVChecker();

    await checker.scanRejectedCSVs();

    let response;
    switch (format) {
      case "detailed":
        response = {
          message: "Rejected CSV files found",
          count: checker.getRejectedTxIds().length,
          data: checker.getDetailedInfo(),
        };
        break;
      case "stats":
        response = {
          message: "Rejected CSV statistics",
          stats: checker.getStats(),
        };
        break;
      case "simple":
      default:
        response = {
          message: "Rejected CSV transaction IDs",
          count: checker.getRejectedTxIds().length,
          txIds: checker.getRejectedTxIds(),
        };
        break;
    }

    res.json(response);
  } catch (error) {
    console.error("Error checking rejected CSVs:", error);
    res.status(500).json({
      error: "Failed to check rejected CSVs",
      message: error.message,
    });
  }
});

// ============================================================================
// PRICE ENDPOINTS
// ============================================================================

/**
 * Get price data for a token
 * GET /api/prices/:token?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&source=coingecko
 */
app.get("/api/prices/:token", isAuthorized, async (req, res) => {
  try {
    const { token } = req.params;
    const { startDate, endDate, source } = req.query;

    const tokenUpper = token.toUpperCase();
    if (!["AO", "PI", "ARIO"].includes(tokenUpper)) {
      return res.status(400).json({
        error: "Invalid token",
        supported: ["AO", "PI", "ARIO"],
      });
    }

    const client = new cassandra.Client(CONFIG.PRICE_DB);
    await client.connect();

    let query = `
      SELECT date, price_usd, data_source, market_cap_usd, total_volume_usd
      FROM daily_prices
      WHERE token_symbol = ?
    `;
    const params = [tokenUpper];

    if (startDate && endDate) {
      query += " AND date >= ? AND date <= ?";
      params.push(startDate, endDate);
    }

    if (source) {
      query += " AND data_source = ?";
      params.push(source);
    }

    query += " ALLOW FILTERING";

    const result = await client.execute(query, params);
    await client.shutdown();

    res.json({
      token: tokenUpper,
      count: result.rows.length,
      prices: result.rows.map((row) => ({
        date: row.date,
        price_usd: parseFloat(row.price_usd.toString()),
        source: row.data_source,
        market_cap_usd: row.market_cap_usd
          ? parseFloat(row.market_cap_usd.toString())
          : null,
        total_volume_usd: row.total_volume_usd
          ? parseFloat(row.total_volume_usd.toString())
          : null,
      })),
    });
  } catch (error) {
    console.error("Error fetching prices:", error);
    res.status(500).json({
      error: "Failed to fetch prices",
      message: error.message,
    });
  }
});

/**
 * Get price for a specific token and date
 * GET /api/prices/:token/:date?source=coingecko
 */
app.get("/api/prices/:token/:date", isAuthorized, async (req, res) => {
  try {
    const { token, date } = req.params;
    const { source } = req.query;

    const tokenUpper = token.toUpperCase();
    // Map wAR to AR for price lookup
    const lookupToken = tokenUpper === "WAR" ? "AR" : tokenUpper;

    if (!["AR", "WAR", "AO", "PI", "ARIO"].includes(tokenUpper)) {
      return res.status(400).json({
        error: "Invalid token",
        supported: ["AR", "wAR", "AO", "PI", "ARIO"],
      });
    }

    const client = new cassandra.Client(CONFIG.PRICE_DB);
    await client.connect();

    let query = `
      SELECT date, price_usd, data_source, market_cap_usd, total_volume_usd
      FROM daily_prices
      WHERE token_symbol = ? AND date = ?
    `;
    const params = [lookupToken, date];

    if (source) {
      query += " AND data_source = ?";
      params.push(source);
    }

    query += " ALLOW FILTERING";

    const result = await client.execute(query, params);
    await client.shutdown();

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Price not found",
        token: lookupToken,
        date,
      });
    }

    res.json({
      token: tokenUpper,
      date,
      prices: result.rows.map((row) => ({
        price_usd: parseFloat(row.price_usd.toString()),
        source: row.data_source,
        market_cap_usd: row.market_cap_usd
          ? parseFloat(row.market_cap_usd.toString())
          : null,
        total_volume_usd: row.total_volume_usd
          ? parseFloat(row.total_volume_usd.toString())
          : null,
      })),
    });
  } catch (error) {
    console.error("Error fetching price:", error);
    res.status(500).json({
      error: "Failed to fetch price",
      message: error.message,
    });
  }
});

// ============================================================================
// JOB ENDPOINTS
// ============================================================================

/**
 * Trigger distribution update job
 * POST /api/jobs/update-distributions
 */
app.post("/api/jobs/update-distributions", isAuthorized, async (req, res) => {
  try {
    const { forceReprocess = false } = req.body;

    console.log("🚀 Starting distribution update job...");
    if (forceReprocess) {
      console.log("🔄 Force reprocess mode enabled - will reprocess all CSVs");
    }

    updateJobStatus("update-ao-distributions", "running");
    updateJobStatus("update-pi-distributions", "running");
    updateJobStatus("update-ario-distributions", "running");

    // Run the indexers asynchronously
    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    res.json({
      message: forceReprocess
        ? "Distribution update job started (force reprocess mode)"
        : "Distribution update job started",
      status: "running",
      timestamp: new Date().toISOString(),
      forceReprocess,
    });

    // Run in background
    (async () => {
      try {
        console.log("📊 Running AO distribution indexer...");
        const aoCommand = forceReprocess
          ? "node src/indexers/ao_distribution_indexer_cassandra.js --force-reprocess"
          : "node src/indexers/ao_distribution_indexer_cassandra.js";
        const aoResult = await execPromise(aoCommand, {
          cwd: __dirname,
          maxBuffer: 50 * 1024 * 1024, // 50MB buffer
        });

        // Log the detailed output from the script
        if (aoResult.stdout) {
          console.log("📊 AO Distribution Indexer Output:");
          console.log(aoResult.stdout);
        }
        if (aoResult.stderr) {
          console.log("⚠️  AO Distribution Indexer Errors:");
          console.log(aoResult.stderr);
        }

        updateJobStatus("update-ao-distributions", "completed");
        console.log("✅ AO distribution indexer completed");

        console.log("📊 Running PI distribution indexer...");
        const piCommand = forceReprocess
          ? "node src/indexers/pi_distribution_indexer_cassandra.js --force-reprocess"
          : "node src/indexers/pi_distribution_indexer_cassandra.js";
        const piResult = await execPromise(piCommand, {
          cwd: __dirname,
          maxBuffer: 50 * 1024 * 1024, // 50MB buffer
        });

        // Log the detailed output from the script
        if (piResult.stdout) {
          console.log("📊 PI Distribution Indexer Output:");
          console.log(piResult.stdout);
        }
        if (piResult.stderr) {
          console.log("⚠️  PI Distribution Indexer Errors:");
          console.log(piResult.stderr);
        }

        updateJobStatus("update-pi-distributions", "completed");
        console.log("✅ PI distribution indexer completed");

        console.log("📊 Running ARIO distribution indexer...");
        const arioResult = await execPromise(
          "node src/indexers/ario_distribution_indexer_cassandra.js",
          {
            cwd: __dirname,
            maxBuffer: 50 * 1024 * 1024, // 50MB buffer
          },
        );

        // Log the detailed output from the script
        if (arioResult.stdout) {
          console.log("📊 ARIO Distribution Indexer Output:");
          console.log(arioResult.stdout);
        }
        if (arioResult.stderr) {
          console.log("⚠️  ARIO Distribution Indexer Errors:");
          console.log(arioResult.stderr);
        }

        updateJobStatus("update-ario-distributions", "completed");
        console.log("✅ ARIO distribution indexer completed");

        console.log("✅ Distribution update job completed");
      } catch (error) {
        console.error("❌ Distribution update job failed:", error);
        updateJobStatus("update-ao-distributions", "error", error);
        updateJobStatus("update-pi-distributions", "error", error);
        updateJobStatus("update-ario-distributions", "error", error);
      }
    })();
  } catch (error) {
    console.error("Error starting distribution update:", error);
    updateJobStatus("update-ao-distributions", "error", error);
    updateJobStatus("update-pi-distributions", "error", error);
    updateJobStatus("update-ario-distributions", "error", error);
    res.status(500).json({
      error: "Failed to start distribution update",
      message: error.message,
    });
  }
});

/**
 * Trigger AO distribution indexer
 * POST /api/jobs/update-ao-distributions
 */
app.post(
  "/api/jobs/update-ao-distributions",
  isAuthorized,
  async (req, res) => {
    try {
      const { forceReprocess = false } = req.body;

      console.log("🚀 Starting AO distribution update job...");
      if (forceReprocess) {
        console.log(
          "🔄 Force reprocess mode enabled - will reprocess all CSVs",
        );
      }

      updateJobStatus("update-ao-distributions", "running");

      const { exec } = require("child_process");
      const util = require("util");
      const execPromise = util.promisify(exec);

      res.json({
        message: forceReprocess
          ? "AO distribution update job started (force reprocess mode)"
          : "AO distribution update job started",
        status: "running",
        timestamp: new Date().toISOString(),
        forceReprocess,
      });

      // Run in background
      (async () => {
        try {
          console.log("📊 Running AO distribution indexer...");
          const aoCommand = forceReprocess
            ? "node src/indexers/ao_distribution_indexer_cassandra.js --force-reprocess"
            : "node src/indexers/ao_distribution_indexer_cassandra.js";
          const aoResult = await execPromise(aoCommand, {
            cwd: __dirname,
            maxBuffer: 50 * 1024 * 1024, // 50MB buffer
          });

          // Log the detailed output from the script
          if (aoResult.stdout) {
            console.log("📊 AO Distribution Indexer Output:");
            console.log(aoResult.stdout);
          }
          if (aoResult.stderr) {
            console.log("⚠️  AO Distribution Indexer Errors:");
            console.log(aoResult.stderr);
          }

          updateJobStatus("update-ao-distributions", "completed");
          console.log("✅ AO distribution indexer completed");
        } catch (error) {
          console.error("❌ AO distribution update job failed:", error);
          updateJobStatus("update-ao-distributions", "error", error);
        }
      })();
    } catch (error) {
      console.error("Error starting AO distribution update:", error);
      updateJobStatus("update-ao-distributions", "error", error);
      res.status(500).json({
        error: "Failed to start AO distribution update",
        message: error.message,
      });
    }
  },
);

/**
 * Trigger PI distribution indexer
 * POST /api/jobs/update-pi-distributions
 */
app.post(
  "/api/jobs/update-pi-distributions",
  isAuthorized,
  async (req, res) => {
    try {
      const { forceReprocess = false } = req.body;

      console.log("🚀 Starting PI distribution update job...");
      if (forceReprocess) {
        console.log(
          "🔄 Force reprocess mode enabled - will reprocess all CSVs",
        );
      }

      updateJobStatus("update-pi-distributions", "running");

      const { exec } = require("child_process");
      const util = require("util");
      const execPromise = util.promisify(exec);

      res.json({
        message: forceReprocess
          ? "PI distribution update job started (force reprocess mode)"
          : "PI distribution update job started",
        status: "running",
        timestamp: new Date().toISOString(),
        forceReprocess,
      });

      // Run in background
      (async () => {
        try {
          console.log("📊 Running PI distribution indexer...");
          const piCommand = forceReprocess
            ? "node src/indexers/pi_distribution_indexer_cassandra.js --force-reprocess"
            : "node src/indexers/pi_distribution_indexer_cassandra.js";
          const piResult = await execPromise(piCommand, {
            cwd: __dirname,
            maxBuffer: 50 * 1024 * 1024, // 50MB buffer
          });

          // Log the detailed output from the script
          if (piResult.stdout) {
            console.log("📊 PI Distribution Indexer Output:");
            console.log(piResult.stdout);
          }
          if (piResult.stderr) {
            console.log("⚠️  PI Distribution Indexer Errors:");
            console.log(piResult.stderr);
          }

          updateJobStatus("update-pi-distributions", "completed");
          console.log("✅ PI distribution indexer completed");
        } catch (error) {
          console.error("❌ PI distribution update job failed:", error);
          updateJobStatus("update-pi-distributions", "error", error);
        }
      })();
    } catch (error) {
      console.error("Error starting PI distribution update:", error);
      updateJobStatus("update-pi-distributions", "error", error);
      res.status(500).json({
        error: "Failed to start PI distribution update",
        message: error.message,
      });
    }
  },
);

/**
 * Trigger ARIO gateway testnet indexer (one-time use)
 * POST /api/jobs/index-ario-testnet
 */
app.post("/api/jobs/index-ario-testnet", isAuthorized, async (req, res) => {
  try {
    console.log("🚀 Starting ARIO gateway testnet indexer (one-time)...");

    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    res.json({
      message: "ARIO gateway testnet indexer started",
      status: "running",
      note: "This is a one-time job for historical testnet data",
      timestamp: new Date().toISOString(),
    });

    // Run in background
    (async () => {
      try {
        console.log("🔐 Running ARIO gateway testnet indexer...");
        await execPromise("node src/indexers/ario_gateway_testnet_indexer.js", {
          cwd: __dirname,
          maxBuffer: 50 * 1024 * 1024, // 50MB buffer
        });
        console.log("✅ ARIO gateway testnet indexer completed");
      } catch (error) {
        console.error("❌ ARIO gateway testnet indexer failed:", error);
      }
    })();
  } catch (error) {
    console.error("Error starting ARIO gateway testnet indexer:", error);
    res.status(500).json({
      error: "Failed to start ARIO gateway testnet indexer",
      message: error.message,
    });
  }
});

/**
 * Trigger price update job
 * POST /api/jobs/update-prices
 */
app.post("/api/jobs/update-prices", isAuthorized, async (req, res) => {
  try {
    console.log("🚀 Starting price update job...");
    updateJobStatus("update-ao-prices", "running");
    updateJobStatus("update-ario-prices", "running");
    updateJobStatus("update-permaswap-prices", "running");

    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    res.json({
      message: "Price update job started",
      status: "running",
      timestamp: new Date().toISOString(),
    });

    // Run in background
    (async () => {
      try {
        console.log("💰 Running comprehensive price update job...");

        const { spawn } = require("child_process");
        const priceUpdateProcess = spawn("node", ["jobs/update-prices.js"], {
          stdio: "inherit", // Stream output in real-time
          cwd: __dirname,
        });

        priceUpdateProcess.on("close", (code) => {
          if (code === 0) {
            updateJobStatus("update-ao-prices", "completed");
            updateJobStatus("update-ario-prices", "completed");
            updateJobStatus("update-permaswap-prices", "completed");
            console.log("✅ Price update job completed");
          } else {
            console.error(`❌ Price update job failed with exit code ${code}`);
            updateJobStatus("update-ao-prices", "error", {
              message: `Process exited with code ${code}`,
            });
            updateJobStatus("update-ario-prices", "error", {
              message: `Process exited with code ${code}`,
            });
            updateJobStatus("update-permaswap-prices", "error", {
              message: `Process exited with code ${code}`,
            });
          }
        });

        priceUpdateProcess.on("error", (error) => {
          console.error("❌ Price update job failed:", error);
          updateJobStatus("update-ao-prices", "error", error);
          updateJobStatus("update-ario-prices", "error", error);
          updateJobStatus("update-permaswap-prices", "error", error);
        });
      } catch (error) {
        console.error("❌ Price update job failed:", error);
        updateJobStatus("update-ao-prices", "error", error);
        updateJobStatus("update-ario-prices", "error", error);
        updateJobStatus("update-permaswap-prices", "error", error);
      }
    })();
  } catch (error) {
    console.error("Error starting price update:", error);
    updateJobStatus("update-ao-prices", "error", error);
    updateJobStatus("update-ario-prices", "error", error);
    updateJobStatus("update-permaswap-prices", "error", error);
    res.status(500).json({
      error: "Failed to start price update",
      message: error.message,
    });
  }
});

/**
 * Trigger full update (distributions + prices)
 * POST /api/jobs/update-all
 */
app.post("/api/jobs/update-all", isAuthorized, async (req, res) => {
  try {
    const { forceReprocess = false } = req.body;

    console.log("🚀 Starting full update job...");
    if (forceReprocess) {
      console.log("🔄 Force reprocess mode enabled - will reprocess all CSVs");
    }

    updateJobStatus("update-all", "running");

    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    res.json({
      message: forceReprocess
        ? "Full update job started (force reprocess mode)"
        : "Full update job started",
      status: "running",
      timestamp: new Date().toISOString(),
      forceReprocess,
    });

    // Run in background
    (async () => {
      try {
        console.log("📊 Running AO distribution indexer...");
        updateJobStatus("update-all", "running", null, "ao-distributions");
        const aoCommand = forceReprocess
          ? "node src/indexers/ao_distribution_indexer_cassandra.js --force-reprocess"
          : "node src/indexers/ao_distribution_indexer_cassandra.js";
        const aoResult = await execPromise(aoCommand, {
          cwd: __dirname,
          maxBuffer: 50 * 1024 * 1024, // 50MB buffer
        });

        // Log the detailed output from the script
        if (aoResult.stdout) {
          console.log("📊 AO Distribution Indexer Output:");
          console.log(aoResult.stdout);
        }
        if (aoResult.stderr) {
          console.log("⚠️  AO Distribution Indexer Errors:");
          console.log(aoResult.stderr);
        }

        updateJobStatus("update-all", "completed", null, "ao-distributions");
        console.log("✅ AO distribution indexer completed");

        console.log("📊 Running PI distribution indexer...");
        updateJobStatus("update-all", "running", null, "pi-distributions");
        const piCommand = forceReprocess
          ? "node src/indexers/pi_distribution_indexer_cassandra.js --force-reprocess"
          : "node src/indexers/pi_distribution_indexer_cassandra.js";
        const piResult = await execPromise(piCommand, {
          cwd: __dirname,
          maxBuffer: 50 * 1024 * 1024, // 50MB buffer
        });

        // Log the detailed output from the script
        if (piResult.stdout) {
          console.log("📊 PI Distribution Indexer Output:");
          console.log(piResult.stdout);
        }
        if (piResult.stderr) {
          console.log("⚠️  PI Distribution Indexer Errors:");
          console.log(piResult.stderr);
        }

        updateJobStatus("update-all", "completed", null, "pi-distributions");
        console.log("✅ PI distribution indexer completed");

        console.log("📊 Running ARIO distribution indexer...");
        updateJobStatus("update-all", "running", null, "ario-distributions");
        const arioResult = await execPromise(
          "node src/indexers/ario_distribution_indexer_cassandra.js",
          {
            cwd: __dirname,
            maxBuffer: 50 * 1024 * 1024, // 50MB buffer
          },
        );

        // Log the detailed output from the script
        if (arioResult.stdout) {
          console.log("📊 ARIO Distribution Indexer Output:");
          console.log(arioResult.stdout);
        }
        if (arioResult.stderr) {
          console.log("⚠️  ARIO Distribution Indexer Errors:");
          console.log(arioResult.stderr);
        }

        updateJobStatus("update-all", "completed", null, "ario-distributions");
        console.log("✅ ARIO distribution indexer completed");

        console.log("🔐 Running ARIO gateway mainnet indexer...");
        updateJobStatus("update-all", "running", null, "ario-gateway-mainnet");
        const today = new Date().toISOString().split("T")[0];
        const yesterday = new Date(Date.now() - 86400000)
          .toISOString()
          .split("T")[0];
        const gatewayResult = await execPromise(
          `node src/indexers/ario_gateway_mainnet_indexer.js ${yesterday} ${today}`,
          {
            cwd: __dirname,
            maxBuffer: 50 * 1024 * 1024, // 50MB buffer
          },
        );

        // Log the detailed output from the script
        if (gatewayResult.stdout) {
          console.log("🔐 ARIO Gateway Mainnet Indexer Output:");
          console.log(gatewayResult.stdout);
        }
        if (gatewayResult.stderr) {
          console.log("⚠️  ARIO Gateway Mainnet Indexer Errors:");
          console.log(gatewayResult.stderr);
        }

        updateJobStatus(
          "update-all",
          "completed",
          null,
          "ario-gateway-mainnet",
        );
        console.log("✅ ARIO gateway mainnet indexer completed");

        console.log("🎮 Running PIXL distribution indexer...");
        updateJobStatus("update-all", "running", null, "pixl-distributions");
        const pixlResult = await execPromise(
          "node src/indexers/pixl_distribution_indexer.js",
          {
            cwd: __dirname,
            maxBuffer: 50 * 1024 * 1024, // 50MB buffer
          },
        );

        // Log the detailed output from the script
        if (pixlResult.stdout) {
          console.log("🎮 PIXL Distribution Indexer Output:");
          console.log(pixlResult.stdout);
        }
        if (pixlResult.stderr) {
          console.log("⚠️  PIXL Distribution Indexer Errors:");
          console.log(pixlResult.stderr);
        }

        updateJobStatus("update-all", "completed", null, "pixl-distributions");
        console.log("✅ PIXL distribution indexer completed");

        console.log("💰 Running comprehensive price update job...");
        updateJobStatus("update-all", "running", null, "prices");

        const { spawn } = require("child_process");
        const priceUpdateProcess = spawn("node", ["jobs/update-prices.js"], {
          stdio: "inherit", // Stream output in real-time
          cwd: __dirname,
        });

        await new Promise((resolve, reject) => {
          priceUpdateProcess.on("close", (code) => {
            if (code === 0) {
              updateJobStatus("update-all", "completed", null, "prices");
              console.log("✅ Price update job completed");
              resolve();
            } else {
              console.error(
                `❌ Price update job failed with exit code ${code}`,
              );
              reject(
                new Error(`Price update process exited with code ${code}`),
              );
            }
          });

          priceUpdateProcess.on("error", (error) => {
            console.error("❌ Price update job failed:", error);
            reject(error);
          });
        });

        updateJobStatus("update-all", "completed");
        console.log("✅ Full update job completed successfully!");
      } catch (error) {
        console.error("❌ Full update job failed:", error);
        console.error("Error details:", error.message);
        if (error.stdout) console.error("STDOUT:", error.stdout);
        if (error.stderr) console.error("STDERR:", error.stderr);
        updateJobStatus("update-all", "error", error);
      }
    })();
  } catch (error) {
    console.error("Error starting full update:", error);
    updateJobStatus("update-all", "error", error);
    res.status(500).json({
      error: "Failed to start full update",
      message: error.message,
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: "Internal server error",
    message: err.message,
  });
});

// ============================================================================
// INDIVIDUAL INDEXER AND FETCHER ENDPOINTS
// ============================================================================

/**
 * Test route to verify route registration
 * GET /api/test-route
 */
app.get("/api/test-route", (req, res) => {
  res.json({ success: true, message: "Test route works!" });
});

app.get("/api/test-updateJobStatus", (req, res) => {
  res.json({ success: true, message: "updateJobStatus test route works!" });
});

// Simple test for individual job endpoint
app.post("/api/jobs/test-simple", (req, res) => {
  res.json({ success: true, message: "Simple job endpoint works!" });
});

// Test if routes are being registered at all
console.log("🔍 Registering test routes...");

/**
 * Run AO Distribution Indexer
 * POST /api/jobs/ao-distributions
 */
app.post("/api/jobs/ao-distributions", async (req, res) => {
  try {
    console.log("🚀 Starting AO distribution indexer...");
    updateJobStatus("ao-distributions", "running");

    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    const { stdout, stderr } = await execPromise(
      "node src/indexers/ao_distribution_indexer_cassandra.js",
      {
        cwd: __dirname,
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer
      },
    );

    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);

    updateJobStatus("ao-distributions", "completed");
    console.log("✅ AO distribution indexer completed successfully!");

    res.json({
      success: true,
      message: "AO distribution indexer completed successfully",
      output: stdout,
    });
  } catch (error) {
    console.error("❌ AO distribution indexer failed:", error);
    updateJobStatus("ao-distributions", "error", error);
    res.status(500).json({
      error: "AO distribution indexer failed",
      message: error.message,
      output: error.stdout || "",
      errorOutput: error.stderr || "",
    });
  }
});

/**
 * Run PI Distribution Indexer
 * POST /api/jobs/pi-distributions
 */
app.post("/api/jobs/pi-distributions", async (req, res) => {
  try {
    console.log("🚀 Starting PI distribution indexer...");
    updateJobStatus("pi-distributions", "running");

    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    const { stdout, stderr } = await execPromise(
      "node src/indexers/pi_distribution_indexer_cassandra.js",
      {
        cwd: __dirname,
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer
      },
    );

    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);

    updateJobStatus("pi-distributions", "completed");
    console.log("✅ PI distribution indexer completed successfully!");

    res.json({
      success: true,
      message: "PI distribution indexer completed successfully",
      output: stdout,
    });
  } catch (error) {
    console.error("❌ PI distribution indexer failed:", error);
    updateJobStatus("pi-distributions", "error", error);
    res.status(500).json({
      error: "PI distribution indexer failed",
      message: error.message,
      output: error.stdout || "",
      errorOutput: error.stderr || "",
    });
  }
});

/**
 * Run ARIO Distribution Indexer
 * POST /api/jobs/ario-distributions
 */
app.post("/api/jobs/ario-distributions", async (req, res) => {
  try {
    console.log("🚀 Starting ARIO distribution indexer...");
    updateJobStatus("ario-distributions", "running");

    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    const { stdout, stderr } = await execPromise(
      "node src/indexers/ario_distribution_indexer_cassandra.js",
      {
        cwd: __dirname,
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer
      },
    );

    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);

    updateJobStatus("ario-distributions", "completed");
    console.log("✅ ARIO distribution indexer completed successfully!");

    res.json({
      success: true,
      message: "ARIO distribution indexer completed successfully",
      output: stdout,
    });
  } catch (error) {
    console.error("❌ ARIO distribution indexer failed:", error);
    updateJobStatus("ario-distributions", "error", error);
    res.status(500).json({
      error: "ARIO distribution indexer failed",
      message: error.message,
      output: error.stdout || "",
      errorOutput: error.stderr || "",
    });
  }
});

/**
 * Run PIXL Distribution Indexer
 * POST /api/jobs/pixl-distributions
 * Body: { full?: boolean, clear?: boolean, verify?: boolean }
 */
app.post("/api/jobs/pixl-distributions", async (req, res) => {
  try {
    const { full = false, clear = false, verify = false } = req.body || {};

    console.log(
      `🚀 Starting PIXL distribution indexer... (full: ${full}, clear: ${clear}, verify: ${verify})`,
    );
    updateJobStatus("pixl-distributions", "running");

    // If clear is requested, truncate PIXL tables first
    if (clear) {
      console.log("🗑️  Clearing PIXL data before reindexing...");
      const cassandra = require("cassandra-driver");
      const CONFIG = require("./config/database");
      const clearClient = new cassandra.Client(CONFIG.AR_TAX_TRACKER_DB);
      await clearClient.connect();

      try {
        console.log("   Truncating pixl_distributions...");
        await clearClient.execute("TRUNCATE pixl_distributions");

        console.log("   Truncating pixl_distributions_by_block...");
        await clearClient.execute("TRUNCATE pixl_distributions_by_block");

        console.log("   Truncating pixl_streak_events...");
        await clearClient.execute("TRUNCATE pixl_streak_events");

        console.log("   Truncating pixl_indexer_state...");
        await clearClient.execute("TRUNCATE pixl_indexer_state");

        console.log("   Truncating pixl_streak_state...");
        await clearClient.execute("TRUNCATE pixl_streak_state");

        console.log("✅ PIXL data cleared successfully");
      } finally {
        await clearClient.shutdown();
      }
    }

    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    // Build command with flags
    let command = "node src/indexers/pixl_distribution_indexer.js";
    if (full || clear) command += " --full";
    if (verify) command += " --verify";

    console.log(`   Running: ${command}`);

    const { stdout, stderr } = await execPromise(command, {
      cwd: __dirname,
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer
    });

    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);

    updateJobStatus("pixl-distributions", "completed");
    console.log("✅ PIXL distribution indexer completed successfully!");

    res.json({
      success: true,
      message: "PIXL distribution indexer completed successfully",
      cleared: clear,
      full: full || clear,
      output: stdout,
    });
  } catch (error) {
    console.error("❌ PIXL distribution indexer failed:", error);
    updateJobStatus("pixl-distributions", "error", error);
    res.status(500).json({
      error: "PIXL distribution indexer failed",
      message: error.message,
      output: error.stdout || "",
      errorOutput: error.stderr || "",
    });
  }
});

/**
 * Run ARIO Gateway Mainnet Indexer
 * POST /api/jobs/ario-gateway-mainnet
 */
app.post("/api/jobs/ario-gateway-mainnet", async (req, res) => {
  try {
    console.log("🚀 Starting ARIO gateway mainnet indexer...");
    updateJobStatus("ario-gateway-mainnet", "running");

    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    const { stdout, stderr } = await execPromise(
      "node src/indexers/ario_gateway_mainnet_indexer.js",
      {
        cwd: __dirname,
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer
      },
    );

    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);

    updateJobStatus("ario-gateway-mainnet", "completed");
    console.log("✅ ARIO gateway mainnet indexer completed successfully!");

    res.json({
      success: true,
      message: "ARIO gateway mainnet indexer completed successfully",
      output: stdout,
    });
  } catch (error) {
    console.error("❌ ARIO gateway mainnet indexer failed:", error);
    updateJobStatus("ario-gateway-mainnet", "error", error);
    res.status(500).json({
      error: "ARIO gateway mainnet indexer failed",
      message: error.message,
      output: error.stdout || "",
      errorOutput: error.stderr || "",
    });
  }
});

/**
 * Run AO Price Fetcher
 * POST /api/jobs/ao-prices
 */
app.post("/api/jobs/ao-prices", async (req, res) => {
  try {
    console.log("🚀 Starting AO price fetcher...");
    updateJobStatus("ao-prices", "running");

    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    const { stdout, stderr } = await execPromise(
      "node src/fetchers/ao_price_fetcher.js",
      {
        cwd: __dirname,
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer
      },
    );

    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);

    updateJobStatus("ao-prices", "completed");
    console.log("✅ AO price fetcher completed successfully!");

    res.json({
      success: true,
      message: "AO price fetcher completed successfully",
      output: stdout,
    });
  } catch (error) {
    console.error("❌ AO price fetcher failed:", error);
    updateJobStatus("ao-prices", "error", error);
    res.status(500).json({
      error: "AO price fetcher failed",
      message: error.message,
      output: error.stdout || "",
      errorOutput: error.stderr || "",
    });
  }
});

/**
 * Run ARIO Price Fetcher
 * POST /api/jobs/ario-prices
 */
app.post("/api/jobs/ario-prices", async (req, res) => {
  try {
    console.log("🚀 Starting ARIO price fetcher...");
    updateJobStatus("ario-prices", "running");

    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    const { stdout, stderr } = await execPromise(
      "node src/fetchers/ario_price_fetcher.js",
      {
        cwd: __dirname,
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer
      },
    );

    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);

    updateJobStatus("ario-prices", "completed");
    console.log("✅ ARIO price fetcher completed successfully!");

    res.json({
      success: true,
      message: "ARIO price fetcher completed successfully",
      output: stdout,
    });
  } catch (error) {
    console.error("❌ ARIO price fetcher failed:", error);
    updateJobStatus("ario-prices", "error", error);
    res.status(500).json({
      error: "ARIO price fetcher failed",
      message: error.message,
      output: error.stdout || "",
      errorOutput: error.stderr || "",
    });
  }
});

/**
 * Run PI Price Fetcher
 * POST /api/jobs/pi-prices
 */
app.post("/api/jobs/pi-prices", async (req, res) => {
  try {
    console.log("🚀 Starting PI price fetcher...");
    updateJobStatus("pi-prices", "running");

    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    const { stdout, stderr } = await execPromise(
      "node src/fetchers/pi_price_fetcher.js",
      {
        cwd: __dirname,
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer
      },
    );

    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);

    updateJobStatus("pi-prices", "completed");
    console.log("✅ PI price fetcher completed successfully!");

    res.json({
      success: true,
      message: "PI price fetcher completed successfully",
      output: stdout,
    });
  } catch (error) {
    console.error("❌ PI price fetcher failed:", error);
    updateJobStatus("pi-prices", "error", error);
    res.status(500).json({
      error: "PI price fetcher failed",
      message: error.message,
      output: error.stdout || "",
      errorOutput: error.stderr || "",
    });
  }
});

/**
 * Run AR Price Fetcher
 * POST /api/jobs/ar-prices
 */
app.post("/api/jobs/ar-prices", async (req, res) => {
  try {
    console.log("🚀 Starting AR price fetcher...");
    updateJobStatus("ar-prices", "running");

    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    const { stdout, stderr } = await execPromise(
      "node src/fetchers/ar_price_fetcher.js",
      {
        cwd: __dirname,
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer
      },
    );

    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);

    updateJobStatus("ar-prices", "completed");
    console.log("✅ AR price fetcher completed successfully!");

    res.json({
      success: true,
      message: "AR price fetcher completed successfully",
      output: stdout,
    });
  } catch (error) {
    console.error("❌ AR price fetcher failed:", error);
    updateJobStatus("ar-prices", "error", error);
    res.status(500).json({
      error: "AR price fetcher failed",
      message: error.message,
      output: error.stdout || "",
      errorOutput: error.stderr || "",
    });
  }
});

/**
 * Trigger ARIO distribution indexer
 * POST /api/jobs/update-ario-distributions
 */
app.post(
  "/api/jobs/update-ario-distributions",
  isAuthorized,
  async (req, res) => {
    try {
      console.log("🚀 Starting ARIO distribution update job...");

      const { exec } = require("child_process");
      const util = require("util");
      const execPromise = util.promisify(exec);

      res.json({
        message: "ARIO distribution update job started",
        status: "running",
        timestamp: new Date().toISOString(),
      });

      // Run in background
      (async () => {
        try {
          await execPromise(
            "node src/indexers/ario_distribution_indexer_cassandra.js",
            {
              cwd: __dirname,
              maxBuffer: 50 * 1024 * 1024, // 50MB buffer
            },
          );
          console.log("✅ ARIO distribution update job completed");
        } catch (error) {
          console.error("❌ ARIO distribution update job failed:", error);
        }
      })();
    } catch (error) {
      console.error("❌ Error starting ARIO distribution update job:", error);
      res.status(500).json({
        error: "Failed to start ARIO distribution update job",
        message: error.message,
      });
    }
  },
);

/**
 * Trigger ARIO price fetcher
 * POST /api/jobs/update-ario-prices
 */
app.post("/api/jobs/update-ario-prices", isAuthorized, async (req, res) => {
  try {
    console.log("🚀 Starting ARIO price update job...");

    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    res.json({
      message: "ARIO price update job started",
      status: "running",
      timestamp: new Date().toISOString(),
    });

    // Run in background
    (async () => {
      try {
        await execPromise("node src/fetchers/ario_price_history_fetcher.js", {
          cwd: __dirname,
          maxBuffer: 50 * 1024 * 1024, // 50MB buffer
        });
        console.log("✅ ARIO price update job completed");
      } catch (error) {
        console.error("❌ ARIO price update job failed:", error);
      }
    })();
  } catch (error) {
    console.error("❌ Error starting ARIO price update job:", error);
    res.status(500).json({
      error: "Failed to start ARIO price update job",
      message: error.message,
    });
  }
});

/**
 * Test endpoint to verify job execution
 * POST /api/jobs/test-job
 */
app.post("/api/jobs/test-job", isAuthorized, async (req, res) => {
  try {
    console.log("🧪 Testing job execution...");
    updateJobStatus("test-job", "running");

    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    res.json({
      message: "Test job started",
      status: "running",
      timestamp: new Date().toISOString(),
    });

    // Run a simple test
    (async () => {
      try {
        console.log("🔍 Testing simple command execution...");
        const result = await execPromise(
          "echo 'Test job executed successfully'",
          {
            cwd: __dirname,
            maxBuffer: 50 * 1024 * 1024, // 50MB buffer
          },
        );
        console.log("✅ Test job result:", result.stdout);

        console.log("🔍 Testing Node.js version...");
        const nodeResult = await execPromise("node --version", {
          cwd: __dirname,
          maxBuffer: 50 * 1024 * 1024, // 50MB buffer
        });
        console.log("✅ Node.js version:", nodeResult.stdout.trim());

        console.log("🔍 Testing if indexer files exist...");
        const lsResult = await execPromise("ls -la src/indexers/", {
          cwd: __dirname,
          maxBuffer: 50 * 1024 * 1024, // 50MB buffer
        });
        console.log("✅ Indexer files:", lsResult.stdout);

        updateJobStatus("test-job", "completed");
        console.log("✅ Test job completed successfully!");
      } catch (error) {
        console.error("❌ Test job failed:", error);
        console.error("Error details:", error.message);
        if (error.stdout) console.error("STDOUT:", error.stdout);
        if (error.stderr) console.error("STDERR:", error.stderr);
        updateJobStatus("test-job", "error", error);
      }
    })();
  } catch (error) {
    console.error("❌ Error starting test job:", error);
    updateJobStatus("test-job", "error", error);
    res.status(500).json({
      error: "Failed to start test job",
      message: error.message,
    });
  }
});

/**
 * Stop all running jobs
 * POST /api/jobs/stop-all
 */
app.post("/api/jobs/stop-all", async (req, res) => {
  try {
    console.log("🛑 Stopping all running jobs...");

    // Set all jobs to stopped status
    const stoppedJobs = [];
    for (const jobName in jobStatus) {
      if (jobStatus[jobName].status === "running") {
        jobStatus[jobName].status = "stopped";
        jobStatus[jobName].endTime = new Date().toISOString();
        jobStatus[jobName].lastError = "Manually stopped by user";
        stoppedJobs.push(jobName);
      }
    }

    console.log(
      `✅ Stopped ${stoppedJobs.length} running jobs: ${stoppedJobs.join(", ")}`,
    );

    res.json({
      success: true,
      message: `Stopped ${stoppedJobs.length} running jobs`,
      stoppedJobs: stoppedJobs,
      totalJobs: Object.keys(jobStatus).length,
    });
  } catch (error) {
    console.error("❌ Error stopping jobs:", error);
    res.status(500).json({
      error: "Failed to stop jobs",
      message: error.message,
    });
  }
});

// ============================================================================
// AR TRACKER ENDPOINTS - Wallet Tax Report Generation
// ============================================================================

/**
 * Sync wallet transactions (fetch and store)
 * POST /api/wallet/sync
 * Body: { wallet: string | string[], wallets?: string[], fullHistory?: boolean }
 *
 * Supports:
 * - Single wallet: { wallet: "abc123..." }
 * - Multiple wallets: { wallets: ["abc123...", "def456..."] }
 * - Array in wallet: { wallet: ["abc123...", "def456..."] }
 *
 * Max 5 wallets per request. Internal transfers between wallets are auto-detected.
 *
 * Authorization: requires a valid Full Tax Report subscription for the wallet,
 * OR admin bypass (X-Auth-Bypass header) which skips subscription checks entirely.
 */
app.post("/api/wallet/sync", async (req, res, next) => {
  // Allow admin bypass to skip isAuthorized (which requires a year param irrelevant to sync)
  const bypassCode =
    req.headers["x-auth-bypass"] ||
    req.headers["auth-bypass"] ||
    req.query?.authBypass ||
    req.body?.authBypass;
  const adminBypassCode = process.env.ADMIN_AUTH_BYPASS_CODE;
  if (adminBypassCode && bypassCode === adminBypassCode) {
    console.log("🔓 Admin bypass accepted for wallet sync");
    return next();
  }
  return isAuthorized(req, res, next);
}, async (req, res) => {
  req.setTimeout(1800000); // 30 minutes for full sync
  res.setTimeout(1800000);

  try {
    const { wallet, wallets: walletsParam, fullHistory = false } = req.body;

    // Normalize input to array
    const { wallets, primaryWallet } = normalizeWalletInput(
      wallet,
      walletsParam,
    );

    if (wallets.length === 0) {
      return res.status(400).json({
        error: "Missing required parameter",
        required: ["wallet or wallets"],
        example: {
          singleWallet: { wallet: "abc123..." },
          multiWallet: { wallets: ["abc123...", "def456..."] },
        },
      });
    }

    // Validate wallet count
    if (wallets.length > 5) {
      return res.status(400).json({
        error: "Too many wallets",
        message: "Maximum 5 wallets per request",
        provided: wallets.length,
      });
    }

    // Validate wallet addresses
    const validation = validateWallets(wallets);
    if (!validation.valid) {
      return res.status(400).json({
        error: "Invalid wallet address(es)",
        invalid: validation.invalid,
      });
    }

    // Block only if any of these wallets is already being synced (different wallets can sync in parallel)
    const alreadySyncing = wallets.filter((w) => walletSyncInProgress.has(w));
    if (alreadySyncing.length > 0) {
      return res.status(409).json({
        error: "Wallet sync already in progress",
        message: `Sync already running for wallet(s): ${alreadySyncing.slice(0, 3).join(", ")}${alreadySyncing.length > 3 ? " ..." : ""}. Wait for it to complete.`,
        wallets: alreadySyncing,
      });
    }

    wallets.forEach((w) => walletSyncInProgress.add(w));
    try {
      console.log(
        `🔄 Starting wallet sync for ${wallets.length} wallet(s) (fullHistory: ${fullHistory})`,
      );
      wallets.forEach((w, i) => console.log(`   ${i + 1}. ${w}`));

      updateJobStatus("wallet-sync", "running");

      const { results } = await runWalletSync(wallets, { fullHistory });

      updateJobStatus("wallet-sync", "completed");

      res.json({
        success: true,
        wallets,
        primaryWallet,
        walletCount: wallets.length,
        summary: results.summary,
        transactionCount: results.unified.length,
        fetchedAt: results.fetchedAt,
      });
    } catch (error) {
      console.error("Error syncing wallet:", error);
      updateJobStatus("wallet-sync", "error", error);
      res.status(500).json({
        error: "Failed to sync wallet",
        message: error.message,
      });
    } finally {
      wallets.forEach((w) => walletSyncInProgress.delete(w));
    }
  } catch (error) {
    console.error("Error syncing wallet:", error);
    res.status(500).json({
      error: "Failed to sync wallet",
      message: error.message,
    });
  }
});

/**
 * Get wallet transactions (from cache)
 * GET /api/wallet/transactions/:wallet
 */
app.get("/api/wallet/transactions/:wallet", isAuthorized, async (req, res) => {
  try {
    const { wallet } = req.params;
    const { startDate, endDate, taxYear } = req.query;

    if (!wallet) {
      return res.status(400).json({
        error: "Missing wallet address",
      });
    }

    console.log(`📋 Getting transactions for ${wallet}`);

    const cassandraService = new CassandraArTrackerService();
    await cassandraService.connect();

    // Get transactions from database
    const transactions = await cassandraService.getUnifiedTransactions(
      wallet,
      startDate,
      endDate,
    );

    await cassandraService.disconnect();

    // Filter by tax year if specified
    let filteredTransactions = transactions;
    if (taxYear) {
      filteredTransactions = transactions.filter((tx) => {
        const txDate = new Date(tx.block_timestamp);
        return txDate.getFullYear() === parseInt(taxYear);
      });
    }

    res.json({
      wallet,
      transactionCount: filteredTransactions.length,
      transactions: filteredTransactions,
    });
  } catch (error) {
    console.error("Error getting transactions:", error);
    res.status(500).json({
      error: "Failed to get transactions",
      message: error.message,
    });
  }
});

/**
 * Generate PDF tax report
 * POST /api/wallet-report/pdf
 * Body: { wallet: string | string[], wallets?: string[], wallet_group_id?: string, taxYear: number, accountingMethod?: string, currency?: string }
 *
 * Supports multiple wallets - internal transfers between wallets are auto-detected
 * and marked as non-taxable events. When wallet_group_id is provided (e.g. Full Tax Report),
 * wallets are resolved from the group and the limit of 5 does not apply.
 */
app.post("/api/wallet-report/pdf", isAuthorized, async (req, res) => {
  req.setTimeout(1800000); // 30 minutes
  res.setTimeout(1800000);

  try {
    const {
      wallet,
      wallets: walletsParam,
      wallet_group_id: walletGroupId,
      taxYear,
      accountingMethod = "FIFO",
      currency = "USD",
    } = req.body;

    let cassandraService = null;
    let wallets = [];
    let primaryWallet = null;
    const fromWalletGroup = !!walletGroupId;

    if (walletGroupId) {
      cassandraService = new CassandraArTrackerService();
      await cassandraService.connect();
      const group = await cassandraService.getWalletGroup(walletGroupId);
      if (
        !group ||
        !Array.isArray(group.wallets) ||
        group.wallets.length === 0
      ) {
        await cassandraService.disconnect();
        return res.status(400).json({
          error: "Invalid wallet group",
          message: "Wallet group not found or has no wallets",
          wallet_group_id: walletGroupId,
        });
      }
      wallets = [...group.wallets];
      primaryWallet = group.primaryWallet || group.wallets[0];
    } else {
      const normalized = normalizeWalletInput(wallet, walletsParam);
      wallets = normalized.wallets;
      primaryWallet = normalized.primaryWallet;
    }

    if (wallets.length === 0 || !taxYear) {
      if (cassandraService) await cassandraService.disconnect();
      return res.status(400).json({
        error: "Missing required parameters",
        required: ["wallet or wallets or wallet_group_id", "taxYear"],
        example: {
          singleWallet: { wallet: "abc123...", taxYear: 2025 },
          multiWallet: { wallets: ["abc123...", "def456..."], taxYear: 2025 },
          fullTaxReport: { wallet_group_id: "uuid...", taxYear: 2025 },
        },
      });
    }

    // Validate wallet count (only when not using a wallet group - Full Tax Report can have many)
    if (!fromWalletGroup && wallets.length > 5) {
      if (cassandraService) await cassandraService.disconnect();
      return res.status(400).json({
        error: "Too many wallets",
        message: "Maximum 5 wallets per request",
        provided: wallets.length,
      });
    }

    // Validate wallet addresses
    const validation = validateWallets(wallets);
    if (!validation.valid) {
      if (cassandraService) await cassandraService.disconnect();
      return res.status(400).json({
        error: "Invalid wallet address(es)",
        invalid: validation.invalid,
      });
    }

    console.log(
      `📄 Generating tax report PDF for ${wallets.length} wallet(s) (${taxYear}, ${accountingMethod})${fromWalletGroup ? " [wallet group]" : ""}`,
    );
    wallets.forEach((w, i) => console.log(`   ${i + 1}. ${w}`));

    updateJobStatus("wallet-report", "running");

    // Reuse Cassandra connection if we already opened it for wallet_group_id
    if (!cassandraService) {
      cassandraService = new CassandraArTrackerService();
      await cassandraService.connect();
    }

    const priceService = new PriceService({
      keyspace: CONFIG.PRICE_DB.keyspace,
      contactPoints: CONFIG.PRICE_DB.contactPoints,
      localDataCenter: CONFIG.PRICE_DB.localDataCenter,
    });
    await priceService.connect();

    const costBasisService = new CostBasisService({ cassandraService });

    // Report range: full calendar year for requested taxYear (e.g. 2026 → 1/1/2026–12/31/2026)
    const startDate = `${taxYear}-01-01`;
    const endDate = `${taxYear}-12-31`;
    const transactions =
      await cassandraService.getUnifiedTransactionsMultiWallet(wallets, {
        startDate,
        endDate,
        markInternalTransfers: true,
      });

    // Note: Distributions are now included in unified_transactions_originals during wallet indexing
    // No need to fetch them separately - the transactions already include all data sources
    console.log(
      `📊 Found ${transactions.length} pre-indexed transactions (includes distributions)`,
    );

    // Load Bazar profiles and their transactions (from cache only - no AO calls during report)
    let profileTransactions = [];
    let discoveredProfiles = [];
    let expandedWallets = [...wallets];
    try {
      const bazarProfileService = new BazarProfileService({
        cassandraService,
        verbose: false,
      });
      const walletSet = await bazarProfileService.getExpandedWalletSetCached(
        wallets,
        { cacheOnly: true },
      );
      discoveredProfiles = walletSet.profiles || [];

      if (discoveredProfiles.length > 0) {
        console.log(
          `👤 Found ${discoveredProfiles.length} cached Bazar profile(s):`,
        );
        discoveredProfiles.forEach((p, i) => {
          console.log(`   ${i + 1}. ${p.username || "(unnamed)"}`);
          console.log(`      Profile ID: ${p.profileId}`);
          console.log(
            `      Owner: ${p.parentWallet || p.walletAddress || "unknown"}`,
          );
        });
        const profileIds = discoveredProfiles.map((p) => p.profileId);
        expandedWallets = [...wallets, ...profileIds];

        // Get profile transactions from database
        profileTransactions =
          await cassandraService.getProfileTransactionsForProfiles(profileIds, {
            startDate: new Date(`${taxYear}-01-01`),
            endDate: new Date(`${taxYear}-12-31T23:59:59`),
          });
        console.log(
          `📋 Loaded ${profileTransactions.length} profile transactions for ${taxYear}`,
        );
      }
    } catch (profileError) {
      console.log(
        `⚠️ Profile loading error (continuing without profiles): ${profileError.message}`,
      );
    }

    // Sort by timestamp and prepare for merging
    const allTransactions = [...transactions].sort(
      (a, b) =>
        (a.blockTimestamp || a.timestamp || 0) -
        (b.blockTimestamp || b.timestamp || 0),
    );

    // Merge profile transactions with unique key deduplication
    const txIds = new Set(allTransactions.map((tx) => tx.txId));
    for (const ptx of profileTransactions) {
      if (!txIds.has(ptx.txId)) {
        const profile = discoveredProfiles.find(
          (p) => p.profileId === ptx.profileId,
        );
        allTransactions.push({
          ...ptx,
          walletAddress: ptx.parentWallet,
          isProfileTransaction: true,
          profileUsername: profile?.username,
          profileDisplayName: profile?.displayName,
          source: "bazar_profile",
          isTaxableEvent:
            !ptx.isInternal &&
            ["RECEIVE", "SEND", "DEX_SWAP"].includes(ptx.type),
          taxCategory: ptx.type === "SEND" ? "DISPOSAL" : "ACQUISITION",
        });
        txIds.add(ptx.txId);
      }
    }

    // Re-sort after adding profile transactions
    allTransactions.sort(
      (a, b) =>
        (a.blockTimestamp || a.timestamp || 0) -
        (b.blockTimestamp || b.timestamp || 0),
    );

    // Enrich with prices
    await priceService.enrichWithPrices(allTransactions);

    // Enrich disposals with cost basis from pre-computed data
    console.log(`💰 Enriching disposals with pre-computed cost basis...`);
    const disposalTypes = ["SEND", "DEX_SWAP", "SWAP", "SALE", "TRADE"];
    let enrichedCount = 0;
    for (const tx of allTransactions) {
      if (disposalTypes.includes(tx.type)) {
        // Look up cost basis for this disposal
        const costBasisInfo = await costBasisService.getDisposalByTxId(tx.txId);
        if (costBasisInfo && costBasisInfo.costBasis !== undefined) {
          tx.costBasisUSD = costBasisInfo.costBasis;
          enrichedCount++;
        }
      }
    }
    console.log(`💰 Enriched ${enrichedCount} disposals with cost basis`);

    // Initialize FiatConversionService if needed
    let fiatService = null;
    if (currency !== "USD") {
      fiatService = new FiatConversionService();
      await fiatService.connect();
    }

    // Generate PDF using TaxReportGenerator
    const generator = new TaxReportGenerator({
      outputDir: __dirname,
      costBasisService,
      fiatConversionService: fiatService,
    });

    // Pass all wallets (including profiles) for comprehensive multi-wallet report
    const pdfPath = await generator.generateComprehensivePDF(
      wallets.length === 1 ? primaryWallet : wallets,
      allTransactions,
      {
        taxYear,
        currency,
        includeNonTaxable: false,
        wallets: expandedWallets, // Pass full wallet list including profile IDs for internal transfer detection
        profiles: discoveredProfiles, // Include profile info for report display
      },
    );

    // Read and send PDF
    const pdfBuffer = fs.readFileSync(pdfPath);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${path.basename(pdfPath)}"`,
    );
    res.setHeader("Content-Length", pdfBuffer.length);
    res.send(pdfBuffer);

    // Cleanup
    fs.unlinkSync(pdfPath);
    await cassandraService.disconnect();
    await priceService.disconnect();
    if (fiatService) await fiatService.disconnect();

    updateJobStatus("wallet-report", "completed");
  } catch (error) {
    console.error("Error generating tax report PDF:", error);
    updateJobStatus("wallet-report", "error", error);
    res.status(500).json({
      error: "Failed to generate tax report",
      message: error.message,
    });
  }
});

/**
 * Generate CSV tax report
 * POST /api/wallet-report/csv
 * Body: { wallet: string | string[], wallets?: string[], wallet_group_id?: string, taxYear: number, reportType?: string, currency?: string }
 * reportType: "all" | "transactions" | "capital_gains" | "income" | "form8949" (default: "all")
 *
 * Supports multiple wallets - internal transfers between wallets are auto-detected
 * and marked as non-taxable events. When wallet_group_id is provided (e.g. Full Tax Report),
 * wallets are resolved from the group and the limit of 5 does not apply.
 */
app.post("/api/wallet-report/csv", isAuthorized, async (req, res) => {
  req.setTimeout(1800000); // 30 minutes
  res.setTimeout(1800000);

  try {
    const {
      wallet,
      wallets: walletsParam,
      wallet_group_id: walletGroupId,
      taxYear,
      reportType = "all",
      currency = "USD",
    } = req.body;

    let cassandraService = null;
    let wallets = [];
    let primaryWallet = null;
    const fromWalletGroup = !!walletGroupId;

    if (walletGroupId) {
      cassandraService = new CassandraArTrackerService();
      await cassandraService.connect();
      const group = await cassandraService.getWalletGroup(walletGroupId);
      if (
        !group ||
        !Array.isArray(group.wallets) ||
        group.wallets.length === 0
      ) {
        await cassandraService.disconnect();
        return res.status(400).json({
          error: "Invalid wallet group",
          message: "Wallet group not found or has no wallets",
          wallet_group_id: walletGroupId,
        });
      }
      wallets = [...group.wallets];
      primaryWallet = group.primaryWallet || group.wallets[0];
    } else {
      const normalized = normalizeWalletInput(wallet, walletsParam);
      wallets = normalized.wallets;
      primaryWallet = normalized.primaryWallet;
    }

    if (wallets.length === 0 || !taxYear) {
      if (cassandraService) await cassandraService.disconnect();
      return res.status(400).json({
        error: "Missing required parameters",
        required: ["wallet or wallets or wallet_group_id", "taxYear"],
        optional: [
          "reportType (all|transactions|capital_gains|income|form8949)",
          "currency",
        ],
        example: {
          singleWallet: { wallet: "abc123...", taxYear: 2025 },
          multiWallet: { wallets: ["abc123...", "def456..."], taxYear: 2025 },
          fullTaxReport: { wallet_group_id: "uuid...", taxYear: 2025 },
        },
      });
    }

    // Validate wallet count (only when not using a wallet group)
    if (!fromWalletGroup && wallets.length > 5) {
      if (cassandraService) await cassandraService.disconnect();
      return res.status(400).json({
        error: "Too many wallets",
        message: "Maximum 5 wallets per request",
        provided: wallets.length,
      });
    }

    // Validate wallet addresses
    const validation = validateWallets(wallets);
    if (!validation.valid) {
      if (cassandraService) await cassandraService.disconnect();
      return res.status(400).json({
        error: "Invalid wallet address(es)",
        invalid: validation.invalid,
      });
    }

    const validReportTypes = [
      "all",
      "transactions",
      "capital_gains",
      "income",
      "form8949",
    ];
    if (!validReportTypes.includes(reportType)) {
      if (cassandraService) await cassandraService.disconnect();
      return res.status(400).json({
        error: "Invalid report type",
        valid: validReportTypes,
      });
    }

    console.log(
      `📄 Generating CSV report (${reportType}) for ${wallets.length} wallet(s) (${taxYear})${fromWalletGroup ? " [wallet group]" : ""}`,
    );
    wallets.forEach((w, i) => console.log(`   ${i + 1}. ${w}`));

    updateJobStatus("wallet-report", "running");

    // Reuse Cassandra connection if we already opened it for wallet_group_id
    if (!cassandraService) {
      cassandraService = new CassandraArTrackerService();
      await cassandraService.connect();
    }

    const priceService = new PriceService({
      keyspace: CONFIG.PRICE_DB.keyspace,
      contactPoints: CONFIG.PRICE_DB.contactPoints,
      localDataCenter: CONFIG.PRICE_DB.localDataCenter,
    });
    await priceService.connect();

    const costBasisService = new CostBasisService({ cassandraService });

    // Report range: full calendar year for requested taxYear (e.g. 2026 → 1/1/2026–12/31/2026)
    const startDate = `${taxYear}-01-01`;
    const endDate = `${taxYear}-12-31`;
    const transactions =
      await cassandraService.getUnifiedTransactionsMultiWallet(wallets, {
        startDate,
        endDate,
        markInternalTransfers: true,
      });

    // Note: Distributions are now included in unified_transactions_originals during wallet indexing
    // No need to fetch them separately - the transactions already include all data sources
    console.log(
      `📊 Found ${transactions.length} pre-indexed transactions (includes distributions)`,
    );

    // Load Bazar profiles and their transactions (from cache only - no AO calls during report)
    let csvProfileTransactions = [];
    let csvDiscoveredProfiles = [];
    let csvExpandedWallets = [...wallets];
    try {
      const bazarProfileService = new BazarProfileService({
        cassandraService,
        verbose: false,
      });
      const walletSet = await bazarProfileService.getExpandedWalletSetCached(
        wallets,
        { cacheOnly: true },
      );
      csvDiscoveredProfiles = walletSet.profiles || [];

      if (csvDiscoveredProfiles.length > 0) {
        console.log(
          `👤 Found ${csvDiscoveredProfiles.length} cached Bazar profile(s):`,
        );
        csvDiscoveredProfiles.forEach((p, i) => {
          console.log(`   ${i + 1}. ${p.username || "(unnamed)"}`);
          console.log(`      Profile ID: ${p.profileId}`);
          console.log(
            `      Owner: ${p.parentWallet || p.walletAddress || "unknown"}`,
          );
        });
        const profileIds = csvDiscoveredProfiles.map((p) => p.profileId);
        csvExpandedWallets = [...wallets, ...profileIds];

        // Get profile transactions from database
        csvProfileTransactions =
          await cassandraService.getProfileTransactionsForProfiles(profileIds, {
            startDate: new Date(`${taxYear}-01-01`),
            endDate: new Date(`${taxYear}-12-31T23:59:59`),
          });
        console.log(
          `📋 Loaded ${csvProfileTransactions.length} profile transactions for ${taxYear}`,
        );
      }
    } catch (profileError) {
      console.log(
        `⚠️ Profile loading error (continuing without profiles): ${profileError.message}`,
      );
    }

    // Sort by timestamp and prepare for merging
    const allTransactions = [...transactions].sort(
      (a, b) =>
        (a.blockTimestamp || a.timestamp || 0) -
        (b.blockTimestamp || b.timestamp || 0),
    );

    // Merge profile transactions with unique key deduplication
    const csvTxIds = new Set(allTransactions.map((tx) => tx.txId));
    for (const ptx of csvProfileTransactions) {
      if (!csvTxIds.has(ptx.txId)) {
        const profile = csvDiscoveredProfiles.find(
          (p) => p.profileId === ptx.profileId,
        );
        allTransactions.push({
          ...ptx,
          walletAddress: ptx.parentWallet,
          isProfileTransaction: true,
          profileUsername: profile?.username,
          profileDisplayName: profile?.displayName,
          source: "bazar_profile",
          isTaxableEvent:
            !ptx.isInternal &&
            ["RECEIVE", "SEND", "DEX_SWAP"].includes(ptx.type),
          taxCategory: ptx.type === "SEND" ? "DISPOSAL" : "ACQUISITION",
        });
        csvTxIds.add(ptx.txId);
      }
    }

    // Re-sort after adding profile transactions
    allTransactions.sort(
      (a, b) =>
        (a.blockTimestamp || a.timestamp || 0) -
        (b.blockTimestamp || b.timestamp || 0),
    );

    // Enrich with prices
    await priceService.enrichWithPrices(allTransactions);

    // Enrich disposals with cost basis from pre-computed data
    console.log(`💰 Enriching disposals with pre-computed cost basis...`);
    const csvDisposalTypes = ["SEND", "DEX_SWAP", "SWAP", "SALE", "TRADE"];
    let csvEnrichedCount = 0;
    for (const tx of allTransactions) {
      if (csvDisposalTypes.includes(tx.type)) {
        const costBasisInfo = await costBasisService.getDisposalByTxId(tx.txId);
        if (costBasisInfo && costBasisInfo.costBasis !== undefined) {
          tx.costBasisUSD = costBasisInfo.costBasis;
          csvEnrichedCount++;
        }
      }
    }
    console.log(`💰 Enriched ${csvEnrichedCount} disposals with cost basis`);

    // Initialize FiatConversionService if needed
    let fiatService = null;
    if (currency !== "USD") {
      fiatService = new FiatConversionService();
      await fiatService.connect();
    }

    // Generate CSV using TaxReportGenerator
    const generator = new TaxReportGenerator({
      outputDir: __dirname,
      costBasisService,
      fiatConversionService: fiatService,
    });

    const results = {};
    const timestamp = Date.now();
    const csvFiles = [];

    // Use wallets array for multi-wallet reports, or primaryWallet for single-wallet backward compat
    const reportWalletParam = wallets.length === 1 ? primaryWallet : wallets;

    // Full tax report CSV: single file with all taxable transactions for the wallet group (import-friendly).
    // When reportType is "all" we only generate the transaction report so the response is one CSV.
    if (reportType === "all" || reportType === "transactions") {
      const txResult = await generator.generateTransactionReport(
        allTransactions,
        {
          taxYear: parseInt(taxYear),
          walletAddress: reportWalletParam,
          wallets: csvExpandedWallets, // Pass full list including profiles for internal transfer detection
          format: "csv",
        },
      );
      results.transactions = txResult;
      if (txResult.filepath) csvFiles.push(txResult.filepath);
    }

    // Only generate separate capital_gains / income / form8949 CSVs when a specific report type is requested (not "all").
    if (reportType === "capital_gains") {
      const cgResult = await generator.generateCapitalGainsReport(
        reportWalletParam,
        {
          taxYear: parseInt(taxYear),
          wallets: csvExpandedWallets,
          format: "csv",
        },
      );
      results.capitalGains = cgResult;
      if (cgResult.filepath) csvFiles.push(cgResult.filepath);
    }

    if (reportType === "income") {
      const incResult = await generator.generateIncomeReport(allTransactions, {
        taxYear: parseInt(taxYear),
        walletAddress: reportWalletParam,
        wallets: csvExpandedWallets,
        format: "csv",
      });
      results.income = incResult;
      if (incResult.filepath) csvFiles.push(incResult.filepath);
    }

    if (reportType === "form8949") {
      const f8949Result = await generator.generateForm8949Report(
        reportWalletParam,
        {
          taxYear: parseInt(taxYear),
          wallets: csvExpandedWallets,
        },
      );
      results.form8949 = f8949Result;
      if (f8949Result.shortTermFile) csvFiles.push(f8949Result.shortTermFile);
      if (f8949Result.longTermFile) csvFiles.push(f8949Result.longTermFile);
    }

    // Cleanup services
    await cassandraService.disconnect();
    await priceService.disconnect();
    if (fiatService) await fiatService.disconnect();

    // If single file requested, send directly
    if (csvFiles.length === 1) {
      const csvBuffer = fs.readFileSync(csvFiles[0]);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${path.basename(csvFiles[0])}"`,
      );
      res.setHeader("Content-Length", csvBuffer.length);

      // Cleanup file after sending
      res.on("finish", () => {
        csvFiles.forEach((f) => {
          try {
            fs.unlinkSync(f);
          } catch (e) {
            /* ignore */
          }
        });
      });

      updateJobStatus("wallet-report", "completed");
      return res.send(csvBuffer);
    }

    // Multiple files: return JSON with summaries and download info
    // Note: In production, you'd zip these files. For now, return summary.
    const response = {
      success: true,
      wallets,
      primaryWallet,
      walletCount: wallets.length,
      taxYear,
      reportType,
      currency,
      reports: {},
    };

    for (const [key, value] of Object.entries(results)) {
      if (value && value.summary) {
        response.reports[key] = {
          summary: value.summary,
          recordCount: value.filepath
            ? fs.existsSync(value.filepath)
              ? fs.readFileSync(value.filepath, "utf8").split("\n").length - 1
              : 0
            : 0,
        };
      }
    }

    // Cleanup files
    csvFiles.forEach((f) => {
      try {
        fs.unlinkSync(f);
      } catch (e) {
        /* ignore */
      }
    });

    updateJobStatus("wallet-report", "completed");
    res.json(response);
  } catch (error) {
    console.error("Error generating CSV report:", error);
    updateJobStatus("wallet-report", "error", error);
    res.status(500).json({
      error: "Failed to generate CSV report",
      message: error.message,
    });
  }
});

/**
 * Get wallet report summary (JSON)
 * GET /api/wallet-report/summary/:wallet/:taxYear
 */
app.get(
  "/api/wallet-report/summary/:wallet/:taxYear",
  isAuthorized,
  async (req, res) => {
    try {
      const { wallet, taxYear } = req.params;
      const { accountingMethod = "FIFO" } = req.query;

      if (!wallet || !taxYear) {
        return res.status(400).json({
          error: "Missing required parameters",
          required: ["wallet", "taxYear"],
        });
      }

      console.log(`📊 Getting report summary for ${wallet} (${taxYear})`);

      const cassandraService = new CassandraArTrackerService();
      await cassandraService.connect();

      // Check cache first
      const cached = await cassandraService.getReportSummaryCache(
        wallet,
        parseInt(taxYear),
      );
      if (cached) {
        await cassandraService.disconnect();
        return res.json(cached);
      }

      // Calculate summary
      const startDate = `${taxYear}-01-01`;
      const endDate = `${taxYear}-12-31`;
      const transactions = await cassandraService.getUnifiedTransactions(
        wallet,
        startDate,
        endDate,
      );

      const priceService = new PriceService({
        keyspace: CONFIG.PRICE_DB.keyspace,
        contactPoints: CONFIG.PRICE_DB.contactPoints,
        localDataCenter: CONFIG.PRICE_DB.localDataCenter,
      });
      await priceService.connect();
      await priceService.enrichWithPrices(transactions);

      const costBasisService = new CostBasisService({ cassandraService });
      await costBasisService.processTransactions(
        transactions,
        accountingMethod,
      );

      const summary = {
        wallet,
        taxYear: parseInt(taxYear),
        accountingMethod,
        transactionCount: transactions.length,
        costBasis: costBasisService.getSummary(),
        generatedAt: new Date().toISOString(),
      };

      // Cache the summary
      await cassandraService.saveReportSummaryCache(summary);

      await cassandraService.disconnect();
      await priceService.disconnect();

      res.json(summary);
    } catch (error) {
      console.error("Error getting report summary:", error);
      res.status(500).json({
        error: "Failed to get report summary",
        message: error.message,
      });
    }
  },
);

/**
 * Get DEX price for a token
 * GET /api/dex-prices/:token
 * GET /api/dex-prices/:token/:date
 */
app.get("/api/dex-prices/:token/:date?", async (req, res) => {
  try {
    const { token, date } = req.params;
    const targetDate = date || new Date().toISOString().split("T")[0];

    console.log(`💰 Getting DEX price for ${token} on ${targetDate}`);

    const priceService = new PriceService({
      keyspace: CONFIG.PRICE_DB.keyspace,
      contactPoints: CONFIG.PRICE_DB.contactPoints,
      localDataCenter: CONFIG.PRICE_DB.localDataCenter,
      useDexPrices: true,
    });
    await priceService.connect();

    const price = await priceService.getPrice(token, targetDate);
    const priceWithSource = await priceService.getPriceWithSource(
      token,
      targetDate,
    );

    await priceService.disconnect();

    if (price === null) {
      return res.status(404).json({
        error: "Price not found",
        token,
        date: targetDate,
      });
    }

    res.json({
      token,
      date: targetDate,
      priceUSD: price,
      source: priceWithSource?.source || "unknown",
    });
  } catch (error) {
    console.error("Error getting DEX price:", error);
    res.status(500).json({
      error: "Failed to get DEX price",
      message: error.message,
    });
  }
});

/**
 * Run DEX price indexer
 * POST /api/jobs/dex-price-indexer
 * Body: { incremental?: boolean }
 */
app.post("/api/jobs/dex-price-indexer", async (req, res) => {
  try {
    const { incremental = true } = req.body;

    if (jobStatus["dex-price-indexer"].status === "running") {
      return res.status(409).json({
        error: "Job already running",
        status: jobStatus["dex-price-indexer"],
      });
    }

    console.log(`🔄 Starting DEX price indexer (incremental: ${incremental})`);

    updateJobStatus("dex-price-indexer", "running");

    res.json({
      success: true,
      message: "DEX price indexer started",
      incremental,
    });

    // Run in background
    (async () => {
      try {
        const indexer = new DEXPriceIndexer({
          keyspace: CONFIG.PRICE_DB.keyspace,
          contactPoints: CONFIG.PRICE_DB.contactPoints,
          localDataCenter: CONFIG.PRICE_DB.localDataCenter,
        });

        await indexer.connect();

        if (incremental) {
          await indexer.runIncrementalUpdate();
        } else {
          await indexer.runFullIndex();
        }

        await indexer.disconnect();
        updateJobStatus("dex-price-indexer", "completed");
        console.log("✅ DEX price indexer completed");
      } catch (error) {
        console.error("❌ DEX price indexer failed:", error);
        updateJobStatus("dex-price-indexer", "error", error);
      }
    })();
  } catch (error) {
    console.error("Error starting DEX price indexer:", error);
    updateJobStatus("dex-price-indexer", "error", error);
    res.status(500).json({
      error: "Failed to start DEX price indexer",
      message: error.message,
    });
  }
});

/**
 * Reset DEX price indexer state (admin only)
 * POST /api/admin/dex-indexer/reset
 * Resets the corrupted indexer state (e.g., negative swap counts)
 */
app.post("/api/admin/dex-indexer/reset", isAdmin, async (req, res) => {
  try {
    console.log("🔄 Resetting DEX price indexer state...");

    const indexer = new DEXPriceIndexer({
      keyspace: CONFIG.PRICE_DB.keyspace,
      contactPoints: CONFIG.PRICE_DB.contactPoints,
      localDataCenter: CONFIG.PRICE_DB.localDataCenter,
    });

    await indexer.connect();

    // Get current state for logging
    const currentState = await indexer.getIndexerState("dex_price_indexer");
    console.log(`   Current state: ${JSON.stringify(currentState)}`);

    // Reset state to sane defaults
    await indexer.updateIndexerState("dex_price_indexer", {
      lastIndexedBlock: currentState.lastIndexedBlock || 1500000,
      lastIndexedTimestamp: currentState.lastIndexedTimestamp || 0,
      totalSwapsIndexed: 0, // Reset to 0
      status: "idle",
    });

    await indexer.disconnect();

    console.log("✅ DEX price indexer state reset successfully");

    res.json({
      success: true,
      message: "DEX price indexer state reset",
      previousState: currentState,
      newState: {
        lastIndexedBlock: currentState.lastIndexedBlock || 1500000,
        lastIndexedTimestamp: currentState.lastIndexedTimestamp || 0,
        totalSwapsIndexed: 0,
        status: "idle",
      },
    });
  } catch (error) {
    console.error("❌ Error resetting DEX indexer state:", error);
    res.status(500).json({
      error: "Failed to reset DEX indexer state",
      message: error.message,
    });
  }
});

/**
 * Run fiat rate indexer
 * POST /api/jobs/fiat-rate-indexer
 * Body: { incremental?: boolean }
 */
app.post("/api/jobs/fiat-rate-indexer", async (req, res) => {
  try {
    const { incremental = true } = req.body;

    if (jobStatus["fiat-rate-indexer"].status === "running") {
      return res.status(409).json({
        error: "Job already running",
        status: jobStatus["fiat-rate-indexer"],
      });
    }

    console.log(`🔄 Starting fiat rate indexer (incremental: ${incremental})`);

    updateJobStatus("fiat-rate-indexer", "running");

    res.json({
      success: true,
      message: "Fiat rate indexer started",
      incremental,
    });

    // Run in background
    (async () => {
      try {
        const fiatService = new FiatConversionService({
          keyspace: CONFIG.PRICE_DB.keyspace,
          contactPoints: CONFIG.PRICE_DB.contactPoints,
          localDataCenter: CONFIG.PRICE_DB.localDataCenter,
        });

        await fiatService.connect();

        if (incremental) {
          await fiatService.runIncrementalUpdate();
        } else {
          await fiatService.runFullIndex();
        }

        await fiatService.disconnect();
        updateJobStatus("fiat-rate-indexer", "completed");
        console.log("✅ Fiat rate indexer completed");
      } catch (error) {
        console.error("❌ Fiat rate indexer failed:", error);
        updateJobStatus("fiat-rate-indexer", "error", error);
      }
    })();
  } catch (error) {
    console.error("Error starting fiat rate indexer:", error);
    updateJobStatus("fiat-rate-indexer", "error", error);
    res.status(500).json({
      error: "Failed to start fiat rate indexer",
      message: error.message,
    });
  }
});

/**
 * Convert USD to fiat currency
 * GET /api/fiat-conversion/:amount/:currency/:date?
 */
app.get("/api/fiat-conversion/:amount/:currency/:date?", async (req, res) => {
  try {
    const { amount, currency, date } = req.params;
    const targetDate = date || new Date().toISOString().split("T")[0];
    const usdAmount = parseFloat(amount);

    if (isNaN(usdAmount)) {
      return res.status(400).json({
        error: "Invalid amount",
        message: "Amount must be a valid number",
      });
    }

    console.log(
      `💱 Converting $${usdAmount} USD to ${currency} on ${targetDate}`,
    );

    const fiatService = new FiatConversionService({
      keyspace: CONFIG.PRICE_DB.keyspace,
      contactPoints: CONFIG.PRICE_DB.contactPoints,
      localDataCenter: CONFIG.PRICE_DB.localDataCenter,
    });

    await fiatService.connect();
    const converted = await fiatService.convertFromUSD(
      usdAmount,
      currency,
      targetDate,
    );
    await fiatService.disconnect();

    if (converted === null || converted.amount === null) {
      return res.status(404).json({
        error: "Conversion rate not found",
        currency,
        date: targetDate,
      });
    }

    res.json({
      usdAmount,
      currency,
      date: targetDate,
      convertedAmount: converted.amount,
      exchangeRate: converted.rate,
    });
  } catch (error) {
    console.error("Error converting currency:", error);
    res.status(500).json({
      error: "Failed to convert currency",
      message: error.message,
    });
  }
});

// ============================================================================
// ADMIN ENDPOINTS - Wallet Group Management
// ============================================================================

/**
 * Manually add subscription auth (subscription cache) for wallet(s) + year(s).
 * When multiple wallets are provided for Full Tax Report, also creates a wallet group per year.
 * POST /api/admin/subscriptions
 * Body: { wallets: string[], years: number[], service?: string } or { wallet: string, year: number, service?: string }
 * service defaults to "Full Tax Report". Also accepts "Distribution Report".
 * Requires isAdmin (X-Auth-Bypass).
 */
app.get("/api/admin/referrals/:referrerId", isAdmin, async (req, res) => {
  try {
    const { referrerId } = req.params;
    if (!referrerId || !String(referrerId).trim()) {
      return res.status(400).json({
        error: "referrerId is required",
      });
    }
    const normalized = String(referrerId).trim().toLowerCase();
    const list = await getReferralsByReferrerId(normalized);
    return res.json({
      referrerId: normalized,
      referrals: list,
      count: list.length,
    });
  } catch (e) {
    console.error("GET /api/admin/referrals/:referrerId error:", e);
    return res.status(500).json({
      error: "Failed to list referrals",
      message: e.message,
    });
  }
});

app.patch("/api/admin/referrals/:referrerId/:id", isAdmin, async (req, res) => {
  try {
    const { referrerId, id } = req.params;
    const { paid } = req.body;
    if (!referrerId || !String(referrerId).trim()) {
      return res.status(400).json({ error: "referrerId is required" });
    }
    if (!id || !String(id).trim()) {
      return res.status(400).json({ error: "id is required" });
    }
    if (typeof paid !== "boolean") {
      return res.status(400).json({
        error: "body.paid must be a boolean",
      });
    }
    const normalized = String(referrerId).trim().toLowerCase();
    await updateReferralPaid(normalized, String(id).trim(), paid);
    return res.json({
      success: true,
      referrerId: normalized,
      id: String(id).trim(),
      paid,
    });
  } catch (e) {
    console.error("PATCH /api/admin/referrals/:referrerId/:id error:", e);
    return res.status(500).json({
      error: "Failed to update referral",
      message: e.message,
    });
  }
});

app.post("/api/admin/subscriptions", isAdmin, async (req, res) => {
  const VALID_SERVICES = ["Full Tax Report", "Distribution Report"];
  try {
    const { wallet, wallets, year, years, service: reqService } = req.body;
    const service = reqService || "Full Tax Report";

    if (!VALID_SERVICES.includes(service)) {
      return res.status(400).json({
        error: "Invalid service",
        message: `service must be one of: ${VALID_SERVICES.join(", ")}`,
        provided: service,
      });
    }

    const walletList =
      wallets && Array.isArray(wallets) ? wallets : wallet ? [wallet] : null;
    const yearList =
      years && Array.isArray(years)
        ? years
        : year != null
          ? [Number(year)]
          : null;

    if (
      !walletList ||
      walletList.length === 0 ||
      !yearList ||
      yearList.length === 0
    ) {
      return res.status(400).json({
        error: "Missing required parameters",
        message:
          "Provide wallets (array or single wallet) and years (array or single year)",
        example: {
          wallets: ["addr1"],
          years: [2025],
          service: "Distribution Report",
        },
      });
    }

    for (const y of yearList) {
      const yr = Number(y);
      if (isNaN(yr) || yr < 2000 || yr > 2100) {
        return res.status(400).json({
          error: "Invalid year",
          year: y,
          message: "Year must be 2000-2100",
        });
      }
    }

    if (walletList.length > 5) {
      return res.status(400).json({
        error: "Too many wallets",
        message: "Maximum 5 wallets per group when creating a linked group",
        provided: walletList.length,
      });
    }

    const validation = validateWallets(walletList);
    if (!validation.valid) {
      return res.status(400).json({
        error: "Invalid wallet address(es)",
        invalid: validation.invalid,
      });
    }

    const subscribedAt = Date.now();
    const added = [];

    for (const w of walletList) {
      for (const y of yearList) {
        const yr = Number(y);
        await cacheSubscription(w, service, yr, true, subscribedAt);
        added.push({ wallet: w, year: yr });
      }
    }

    // Wallet groups only apply to Full Tax Report with multiple wallets
    let walletGroups = [];
    if (service === "Full Tax Report" && walletList.length > 1) {
      const cassandraService = new CassandraArTrackerService();
      await cassandraService.connect();
      try {
        for (const yr of yearList) {
          const yearStr = String(yr);
          const group = await cassandraService.createWalletGroup({
            wallets: walletList,
            primaryWallet: walletList[0],
            groupName: `Full Tax Report ${yearStr}`,
            notes: JSON.stringify({ service, year: yearStr }),
            createdBy: "admin",
            autoIndex: false,
          });
          walletGroups.push({
            groupId: group.groupId,
            year: yr,
            wallets: walletList,
          });
          console.log(
            `✅ Admin created wallet group for Full Tax Report ${yearStr}:`,
            group.groupId,
          );
        }
      } finally {
        await cassandraService.disconnect();
      }
    }

    console.log(
      `✅ Admin added ${added.length} ${service} auth(s):`,
      added,
    );
    res.status(201).json({
      success: true,
      message: "Subscription cache updated",
      service,
      added,
      ...(walletGroups.length > 0 && { walletGroups }),
    });
  } catch (error) {
    console.error("Error adding admin subscriptions:", error);
    res.status(500).json({
      error: "Failed to add subscriptions",
      message: error.message,
    });
  }
});

/**
 * Create a new wallet group for indexing
 * POST /api/admin/wallet-groups
 * Body: { wallets: string[], groupName?: string, autoIndex?: boolean, indexIntervalHours?: number, notes?: string }
 */
app.post("/api/admin/wallet-groups", isAdmin, async (req, res) => {
  try {
    const { wallets, groupName, autoIndex, indexIntervalHours, notes } =
      req.body;

    if (!wallets || !Array.isArray(wallets) || wallets.length === 0) {
      return res.status(400).json({
        error: "Missing required parameter",
        required: ["wallets (array of wallet addresses)"],
      });
    }

    if (wallets.length > 5) {
      return res.status(400).json({
        error: "Too many wallets",
        message: "Maximum 5 wallets per group",
        provided: wallets.length,
      });
    }

    // Validate wallet addresses
    const validation = validateWallets(wallets);
    if (!validation.valid) {
      return res.status(400).json({
        error: "Invalid wallet address(es)",
        invalid: validation.invalid,
      });
    }

    console.log(`📝 Creating wallet group with ${wallets.length} wallet(s)`);

    const cassandraService = new CassandraArTrackerService();
    await cassandraService.connect();

    const group = await cassandraService.createWalletGroup({
      wallets,
      groupName,
      primaryWallet: wallets[0],
      autoIndex,
      indexIntervalHours,
      notes,
      createdBy: "admin",
    });

    await cassandraService.disconnect();

    res.status(201).json({
      success: true,
      message: "Wallet group created",
      group,
    });
  } catch (error) {
    console.error("Error creating wallet group:", error);
    res.status(500).json({
      error: "Failed to create wallet group",
      message: error.message,
    });
  }
});

/**
 * Get all wallet groups
 * GET /api/admin/wallet-groups
 * Query: ?status=active|pending|disabled&autoIndex=true|false
 */
app.get("/api/admin/wallet-groups", isAdmin, async (req, res) => {
  try {
    const { status, autoIndex } = req.query;

    console.log("📋 Getting all wallet groups");

    const cassandraService = new CassandraArTrackerService();
    await cassandraService.connect();

    const groups = await cassandraService.getAllWalletGroups({
      status,
      autoIndex:
        autoIndex === "true" ? true : autoIndex === "false" ? false : undefined,
    });

    await cassandraService.disconnect();

    res.json({
      success: true,
      count: groups.length,
      groups,
    });
  } catch (error) {
    console.error("Error getting wallet groups:", error);
    res.status(500).json({
      error: "Failed to get wallet groups",
      message: error.message,
    });
  }
});

/**
 * Get a specific wallet group
 * GET /api/admin/wallet-groups/:groupId
 */
app.get("/api/admin/wallet-groups/:groupId", isAdmin, async (req, res) => {
  try {
    const { groupId } = req.params;

    console.log(`📋 Getting wallet group: ${groupId}`);

    const cassandraService = new CassandraArTrackerService();
    await cassandraService.connect();

    const group = await cassandraService.getWalletGroup(groupId);

    await cassandraService.disconnect();

    if (!group) {
      return res.status(404).json({
        error: "Wallet group not found",
        groupId,
      });
    }

    res.json({
      success: true,
      group,
    });
  } catch (error) {
    console.error("Error getting wallet group:", error);
    res.status(500).json({
      error: "Failed to get wallet group",
      message: error.message,
    });
  }
});

/**
 * Update a wallet group
 * PATCH /api/admin/wallet-groups/:groupId
 * Body: { status?, autoIndex?, indexIntervalHours?, groupName?, notes? }
 */
app.patch("/api/admin/wallet-groups/:groupId", isAdmin, async (req, res) => {
  try {
    const { groupId } = req.params;
    const updates = req.body;

    console.log(`📝 Updating wallet group: ${groupId}`);

    const cassandraService = new CassandraArTrackerService();
    await cassandraService.connect();

    // Check group exists
    const existing = await cassandraService.getWalletGroup(groupId);
    if (!existing) {
      await cassandraService.disconnect();
      return res.status(404).json({
        error: "Wallet group not found",
        groupId,
      });
    }

    await cassandraService.updateWalletGroup(groupId, updates);

    const updated = await cassandraService.getWalletGroup(groupId);
    await cassandraService.disconnect();

    res.json({
      success: true,
      message: "Wallet group updated",
      group: updated,
    });
  } catch (error) {
    console.error("Error updating wallet group:", error);
    res.status(500).json({
      error: "Failed to update wallet group",
      message: error.message,
    });
  }
});

/**
 * Delete a wallet group
 * DELETE /api/admin/wallet-groups/:groupId
 */
app.delete("/api/admin/wallet-groups/:groupId", isAdmin, async (req, res) => {
  try {
    const { groupId } = req.params;

    console.log(`🗑️  Deleting wallet group: ${groupId}`);

    const cassandraService = new CassandraArTrackerService();
    await cassandraService.connect();

    // Check group exists
    const existing = await cassandraService.getWalletGroup(groupId);
    if (!existing) {
      await cassandraService.disconnect();
      return res.status(404).json({
        error: "Wallet group not found",
        groupId,
      });
    }

    await cassandraService.deleteWalletGroup(groupId);
    await cassandraService.disconnect();

    res.json({
      success: true,
      message: "Wallet group deleted",
      groupId,
    });
  } catch (error) {
    console.error("Error deleting wallet group:", error);
    res.status(500).json({
      error: "Failed to delete wallet group",
      message: error.message,
    });
  }
});

/**
 * Trigger indexing for a wallet group
 * POST /api/admin/wallet-groups/:groupId/index
 * Body: { fullHistory?: boolean }
 */
app.post(
  "/api/admin/wallet-groups/:groupId/index",
  isAdmin,
  async (req, res) => {
    req.setTimeout(1800000); // 30 minutes
    res.setTimeout(1800000);

    try {
      const { groupId } = req.params;
      const { fullHistory = false } = req.body;

      console.log(`🔄 Triggering index for wallet group: ${groupId}`);

      const cassandraService = new CassandraArTrackerService();
      await cassandraService.connect();

      // Get the group
      const group = await cassandraService.getWalletGroup(groupId);
      if (!group) {
        await cassandraService.disconnect();
        return res.status(404).json({
          error: "Wallet group not found",
          groupId,
        });
      }

      // Update status to indexing
      await cassandraService.updateWalletGroup(groupId, {
        status: "indexing",
        lastIndexStatus: "running",
        lastIndexError: null,
      });

      // Respond immediately - indexing runs in background
      res.json({
        success: true,
        message: "Indexing started",
        groupId,
        wallets: group.wallets,
        fullHistory,
      });

      // Run indexing in background (shared with Stripe webhook for new Full Tax groups)
      runWalletGroupIndexing(groupId, { fullHistory }).catch((err) =>
        console.error("Wallet group index background error:", err),
      );

      await cassandraService.disconnect();
    } catch (error) {
      console.error("Error triggering index:", error);
      res.status(500).json({
        error: "Failed to trigger index",
        message: error.message,
      });
    }
  },
);

/**
 * Get groups due for indexing (for cron monitoring)
 * GET /api/admin/wallet-groups/due-for-indexing
 */
app.get("/api/admin/wallet-groups-due", isAdmin, async (req, res) => {
  try {
    console.log("📋 Getting wallet groups due for indexing");

    const cassandraService = new CassandraArTrackerService();
    await cassandraService.connect();

    const groups = await cassandraService.getGroupsDueForIndexing();

    await cassandraService.disconnect();

    res.json({
      success: true,
      count: groups.length,
      groups,
    });
  } catch (error) {
    console.error("Error getting groups due for indexing:", error);
    res.status(500).json({
      error: "Failed to get groups due for indexing",
      message: error.message,
    });
  }
});

/**
 * Get server logs for debugging
 * GET /api/admin/logs
 * Query params:
 *   - lines: number of regular log lines (default: 2000)
 *   - errorLines: number of error log lines (default: 500)
 *   - type: "all" | "out" | "error" (default: "all")
 */
app.get("/api/admin/logs", isAdmin, async (req, res) => {
  try {
    const { lines = 2000, errorLines = 500, type = "all" } = req.query;
    const os = require("os");
    const homedir = os.homedir();

    const outLogPath = path.join(homedir, ".pm2/logs/ao-tax-server-out.log");
    const errorLogPath = path.join(
      homedir,
      ".pm2/logs/ao-tax-server-error.log",
    );

    const result = {
      success: true,
      timestamp: new Date().toISOString(),
      logs: {},
    };

    // Helper to read last N lines from a file
    const readLastLines = async (filePath, numLines) => {
      try {
        if (!fs.existsSync(filePath)) {
          return { exists: false, lines: [], error: "File not found" };
        }

        const content = fs.readFileSync(filePath, "utf8");
        const allLines = content.split("\n").filter((line) => line.trim());
        const lastLines = allLines.slice(-parseInt(numLines));

        return {
          exists: true,
          totalLines: allLines.length,
          returnedLines: lastLines.length,
          lines: lastLines,
        };
      } catch (err) {
        return { exists: false, lines: [], error: err.message };
      }
    };

    if (type === "all" || type === "out") {
      result.logs.out = await readLastLines(outLogPath, lines);
    }

    if (type === "all" || type === "error") {
      result.logs.error = await readLastLines(errorLogPath, errorLines);
    }

    res.json(result);
  } catch (error) {
    console.error("Error fetching logs:", error);
    res.status(500).json({
      error: "Failed to fetch logs",
      message: error.message,
    });
  }
});

/**
 * Get PIXL indexer stats (total distributions, last indexed block)
 * GET /api/admin/pixl-stats
 * Use to verify production indexer completion (~475K distributions expected).
 */
app.get("/api/admin/pixl-stats", isAdmin, async (req, res) => {
  let pixlClient = null;
  try {
    pixlClient = new cassandra.Client(CONFIG.AR_TAX_TRACKER_DB);
    await pixlClient.connect();

    const [distCountRes, byBlockCountRes, stateRes] = await Promise.all([
      pixlClient.execute("SELECT COUNT(*) as cnt FROM pixl_distributions"),
      pixlClient.execute(
        "SELECT COUNT(*) as cnt FROM pixl_distributions_by_block",
      ),
      pixlClient.execute(
        "SELECT last_indexed_block, last_indexed_timestamp, distributions_calculated, unique_addresses_seen, last_run_at, status FROM pixl_indexer_state WHERE indexer_name = ?",
        ["pixl_calc"],
        { prepare: true },
      ),
    ]);

    const totalDistributions =
      distCountRes.rows[0]?.cnt?.low ?? distCountRes.rows[0]?.cnt ?? 0;
    const totalByBlock =
      byBlockCountRes.rows[0]?.cnt?.low ?? byBlockCountRes.rows[0]?.cnt ?? 0;
    const state = stateRes.rows[0];

    res.json({
      success: true,
      pixl: {
        totalDistributions: Number(totalDistributions),
        totalDistributionsByBlock: Number(totalByBlock),
        lastIndexedBlock: state?.last_indexed_block ?? null,
        lastIndexedTimestamp: state?.last_indexed_timestamp
          ? new Date(state.last_indexed_timestamp).toISOString()
          : null,
        distributionsCalculated:
          state?.distributions_calculated != null
            ? Number(state.distributions_calculated)
            : null,
        uniqueAddressesSeen:
          state?.unique_addresses_seen != null
            ? Number(state.unique_addresses_seen)
            : null,
        lastRunAt: state?.last_run_at
          ? new Date(state.last_run_at).toISOString()
          : null,
        status: state?.status ?? null,
      },
      expected: {
        totalDistributionsApprox: 475000,
        note: "Full index from genesis should reach ~475K distributions",
      },
    });
  } catch (error) {
    console.error("Error fetching PIXL stats:", error);
    res.status(500).json({
      error: "Failed to fetch PIXL stats",
      message: error.message,
    });
  } finally {
    if (pixlClient) {
      await pixlClient.shutdown();
    }
  }
});

/**
 * Get honeypot attacker statistics
 * GET /api/admin/attackers
 * Returns stats on malicious bot activity caught by honeypots
 */
app.get("/api/admin/attackers", isAdmin, async (req, res) => {
  try {
    const stats = getAttackerStats();
    res.json({
      success: true,
      message: "Honeypot attacker statistics",
      ...stats,
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to get attacker stats",
      message: error.message,
    });
  }
});

/**
 * Get raw honeypot attacker log
 * GET /api/admin/attackers/log
 * Returns the raw log file of all attacker attempts
 */
app.get("/api/admin/attackers/log", isAdmin, async (req, res) => {
  try {
    const log = getAttackerLog();
    res.setHeader("Content-Type", "text/plain");
    res.send(log);
  } catch (error) {
    res.status(500).json({
      error: "Failed to get attacker log",
      message: error.message,
    });
  }
});

/**
 * Debug endpoint: Check price data in database
 * GET /api/admin/prices/:token
 * Query params: limit (default 20), source (optional)
 */
app.get("/api/admin/prices/:token", isAdmin, async (req, res) => {
  try {
    const { token } = req.params;
    const { limit = 20, source } = req.query;

    const tokenUpper = token.toUpperCase();
    const lookupToken = tokenUpper === "WAR" ? "AR" : tokenUpper;

    const client = new cassandra.Client(CONFIG.PRICE_DB);
    await client.connect();

    let query = `
      SELECT date, price_usd, data_source
      FROM daily_prices
      WHERE token_symbol = ?
    `;
    const params = [lookupToken];

    if (source) {
      query += " AND data_source = ?";
      params.push(source);
    }

    query += " LIMIT " + parseInt(limit) + " ALLOW FILTERING";

    const result = await client.execute(query, params, { prepare: true });
    await client.shutdown();

    // Sort by date
    const prices = result.rows
      .map((row) => ({
        date: row.date,
        price: parseFloat(row.price_usd?.toString() || "0"),
        source: row.data_source,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      token: lookupToken,
      count: prices.length,
      prices,
    });
  } catch (error) {
    console.error("Error fetching price data:", error);
    res.status(500).json({
      error: "Failed to fetch price data",
      message: error.message,
    });
  }
});

/**
 * Debug endpoint: Check database schema and sample data
 * GET /api/admin/schema/:table
 * Returns column info and sample rows for debugging schema issues
 */
app.get("/api/admin/schema/:table", isAdmin, async (req, res) => {
  try {
    const { table } = req.params;
    const { keyspace = "ar_tax_tracker", limit = 5 } = req.query;

    // Validate table name to prevent injection
    const allowedTables = [
      "unified_transactions_originals",
      "unified_transactions",
      "tax_lots",
      "tax_lot_originals",
      "disposals",
      "indexer_state",
      "registered_wallet_groups",
      "daily_prices",
      "dex_swaps",
    ];

    if (!allowedTables.includes(table)) {
      return res.status(400).json({
        error: "Invalid table name",
        allowed: allowedTables,
      });
    }

    // Determine keyspace
    const targetKeyspace = ["daily_prices", "dex_swaps"].includes(table)
      ? "ao_price_data"
      : keyspace;

    const client = new cassandra.Client({
      contactPoints: CONFIG.AR_TAX_TRACKER_DB.contactPoints,
      localDataCenter: CONFIG.AR_TAX_TRACKER_DB.localDataCenter,
      keyspace: targetKeyspace,
    });

    await client.connect();

    // Get schema info from system tables
    const schemaQuery = `
      SELECT column_name, type, kind
      FROM system_schema.columns
      WHERE keyspace_name = ? AND table_name = ?
    `;
    const schemaResult = await client.execute(
      schemaQuery,
      [targetKeyspace, table],
      {
        prepare: true,
      },
    );

    // Get sample data
    const sampleQuery = `SELECT * FROM ${table} LIMIT ${parseInt(limit)}`;
    const sampleResult = await client.execute(sampleQuery);

    await client.shutdown();

    // Format columns
    const columns = schemaResult.rows.map((row) => ({
      name: row.column_name,
      type: row.type,
      kind: row.kind, // partition_key, clustering, regular, static
    }));

    // Format sample data (handle BigDecimal and other special types)
    const sampleData = sampleResult.rows.map((row) => {
      const formatted = {};
      for (const [key, value] of Object.entries(row)) {
        if (value === null || value === undefined) {
          formatted[key] = null;
        } else if (
          typeof value === "object" &&
          value.constructor?.name === "BigDecimal"
        ) {
          formatted[key] = parseFloat(value.toString());
        } else if (value instanceof Date) {
          formatted[key] = value.toISOString();
        } else if (typeof value === "bigint") {
          formatted[key] = value.toString();
        } else {
          formatted[key] = value;
        }
      }
      return formatted;
    });

    res.json({
      success: true,
      keyspace: targetKeyspace,
      table,
      columns: columns.sort((a, b) => {
        // Sort: partition_key first, then clustering, then regular
        const order = {
          partition_key: 0,
          clustering: 1,
          static: 2,
          regular: 3,
        };
        return (order[a.kind] || 9) - (order[b.kind] || 9);
      }),
      columnCount: columns.length,
      sampleData,
      sampleCount: sampleData.length,
    });
  } catch (error) {
    console.error("Error fetching schema:", error);
    res.status(500).json({
      error: "Failed to fetch schema",
      message: error.message,
    });
  }
});

/**
 * Debug endpoint: Query raw transactions by wallet and source
 * GET /api/admin/debug/raw-transactions/:wallet
 * Returns raw column data to debug read issues
 */
app.get(
  "/api/admin/debug/raw-transactions/:wallet",
  isAdmin,
  async (req, res) => {
    try {
      const { wallet } = req.params;
      const { source, type, limit = 20 } = req.query;

      const client = new cassandra.Client({
        contactPoints: CONFIG.AR_TAX_TRACKER_DB.contactPoints,
        localDataCenter: CONFIG.AR_TAX_TRACKER_DB.localDataCenter,
        keyspace: "ar_tax_tracker",
      });

      await client.connect();

      // Query with wallet address (partition key)
      let query = `SELECT * FROM unified_transactions_originals WHERE wallet_address = ?`;
      const params = [wallet];

      // Note: Can't filter by source/type without ALLOW FILTERING in Cassandra
      // So we'll fetch all and filter in JS
      const result = await client.execute(query, params, {
        prepare: true,
        fetchSize: 5000,
      });

      await client.shutdown();

      // Filter by source/type if requested
      let filtered = result.rows;
      if (source) {
        filtered = filtered.filter((r) => r.source === source);
      }
      if (type) {
        filtered = filtered.filter((r) => r.type === type);
      }

      // Limit results
      filtered = filtered.slice(0, parseInt(limit));

      // Format for response - show raw column values
      const formattedRows = filtered.map((row) => {
        const formatted = {};
        for (const [key, value] of Object.entries(row)) {
          if (value === null || value === undefined) {
            formatted[key] = null;
          } else if (
            typeof value === "object" &&
            value.constructor?.name === "BigDecimal"
          ) {
            formatted[key] = parseFloat(value.toString());
          } else if (value instanceof Date) {
            formatted[key] = value.toISOString();
          } else if (typeof value === "bigint") {
            formatted[key] = value.toString();
          } else {
            formatted[key] = value;
          }
        }
        return formatted;
      });

      res.json({
        success: true,
        wallet,
        source: source || "all",
        type: type || "all",
        totalInPartition: result.rows.length,
        filteredCount: filtered.length,
        rows: formattedRows,
      });
    } catch (error) {
      console.error("Error querying raw transactions:", error);
      res.status(500).json({
        error: "Failed to query raw transactions",
        message: error.message,
      });
    }
  },
);

/**
 * Diagnostic endpoint: Check database configuration
 * GET /api/admin/debug/db-config
 * Shows current database configuration and tests connection
 */
app.get("/api/admin/debug/db-config", isAdmin, async (req, res) => {
  try {
    const cassandraService = new CassandraArTrackerService({ verbose: true });
    await cassandraService.connect();

    // Test write to see if it works
    const testResult = await cassandraService.client.execute(
      `SELECT keyspace_name FROM system_schema.keyspaces WHERE keyspace_name = ?`,
      ["ar_tax_tracker"],
      { prepare: true },
    );

    // Check if keyspace exists
    const keyspaceExists = testResult.rows.length > 0;

    // Count transactions in the table
    const countResult = await cassandraService.client.execute(
      `SELECT COUNT(*) as count FROM unified_transactions_originals LIMIT 1`,
      [],
      { prepare: false },
    );

    // Count tax lots
    const taxLotsResult = await cassandraService.client.execute(
      `SELECT COUNT(*) as count FROM tax_lots LIMIT 1`,
      [],
      { prepare: false },
    );

    // Count disposals
    const disposalsResult = await cassandraService.client.execute(
      `SELECT COUNT(*) as count FROM disposals LIMIT 1`,
      [],
      { prepare: false },
    );

    await cassandraService.disconnect();

    res.json({
      success: true,
      config: {
        contactPoints: CONFIG.AR_TAX_TRACKER_DB.contactPoints,
        localDataCenter: CONFIG.AR_TAX_TRACKER_DB.localDataCenter,
        keyspace: CONFIG.AR_TAX_TRACKER_DB.keyspace,
        envKeyspace:
          process.env.AR_TAX_TRACKER_KEYSPACE || "(not set, using default)",
      },
      keyspaceExists,
      transactionCount: countResult.rows[0]?.count?.toString() || "0",
      taxLotsCount: taxLotsResult.rows[0]?.count?.toString() || "0",
      disposalsCount: disposalsResult.rows[0]?.count?.toString() || "0",
      tableConfig: CONFIG.AR_TRACKER_TABLES,
    });
  } catch (error) {
    console.error("Error checking DB config:", error);
    res.status(500).json({
      error: "Failed to check DB config",
      message: error.message,
      config: {
        contactPoints: CONFIG.AR_TAX_TRACKER_DB.contactPoints,
        localDataCenter: CONFIG.AR_TAX_TRACKER_DB.localDataCenter,
        keyspace: CONFIG.AR_TAX_TRACKER_DB.keyspace,
      },
    });
  }
});

/**
 * View cost basis data for a wallet group (tax_lots and disposals)
 * GET /api/admin/cost-basis/:groupId
 */
app.get("/api/admin/cost-basis/:groupId", isAdmin, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { limit = 100 } = req.query;

    const cassandraService = new CassandraArTrackerService();
    await cassandraService.connect();

    // Get the group
    const group = await cassandraService.getWalletGroup(groupId);
    if (!group) {
      await cassandraService.disconnect();
      return res.status(404).json({ error: "Wallet group not found", groupId });
    }

    const costBasisService = new CostBasisService({ cassandraService });
    await costBasisService.initializeSchema();

    const result = {
      success: true,
      groupId,
      wallets: group.wallets,
      data: {},
    };

    const commonTokens = [
      "AR",
      "wAR",
      "AO",
      "ARIO",
      "PI",
      "qAR",
      "TRUNK2",
      "EXP",
      "KARD",
      "ANT",
    ];

    for (const wallet of group.wallets) {
      result.data[wallet] = { taxLots: [], disposals: [] };

      // Get tax lots
      for (const token of commonTokens) {
        try {
          const lots = await costBasisService.getTaxLots(wallet, token, {
            includePartial: true,
          });
          if (lots.length > 0) {
            result.data[wallet].taxLots.push(...lots.slice(0, parseInt(limit)));
          }
        } catch (e) {
          // Token might not exist for this wallet
        }
      }

      // Get disposals
      try {
        const disposals = await costBasisService.getDisposals(wallet, {});
        result.data[wallet].disposals = disposals.slice(0, parseInt(limit));
      } catch (e) {
        result.data[wallet].disposalsError = e.message;
      }
    }

    // Summary
    result.summary = {
      totalTaxLots: Object.values(result.data).reduce(
        (sum, w) => sum + w.taxLots.length,
        0,
      ),
      totalDisposals: Object.values(result.data).reduce(
        (sum, w) => sum + w.disposals.length,
        0,
      ),
    };

    await cassandraService.disconnect();
    res.json(result);
  } catch (error) {
    console.error("Error fetching cost basis data:", error);
    res.status(500).json({
      error: "Failed to fetch cost basis data",
      message: error.message,
    });
  }
});

/**
 * Clear cost basis data for a wallet group (tax_lots, disposals, tax_lot_originals)
 * DELETE /api/admin/cost-basis/:groupId
 */
app.delete("/api/admin/cost-basis/:groupId", isAdmin, async (req, res) => {
  try {
    const { groupId } = req.params;

    const cassandraService = new CassandraArTrackerService();
    await cassandraService.connect();

    // Get the group
    const group = await cassandraService.getWalletGroup(groupId);
    if (!group) {
      await cassandraService.disconnect();
      return res.status(404).json({ error: "Wallet group not found", groupId });
    }

    console.log(
      `🗑️ Clearing cost basis data for group ${groupId} (${group.wallets.length} wallets)`,
    );

    const commonTokens = [
      "AR",
      "wAR",
      "AO",
      "ARIO",
      "PI",
      "qAR",
      "TRUNK2",
      "EXP",
      "KARD",
      "ANT",
      "wUSDC",
      "USDA",
    ];
    let lotsDeleted = 0;
    let disposalsDeleted = 0;

    for (const wallet of group.wallets) {
      for (const tokenSymbol of commonTokens) {
        try {
          // Delete tax lots
          await cassandraService.client.execute(
            `DELETE FROM tax_lots WHERE wallet_address = ? AND token_symbol = ?`,
            [wallet, tokenSymbol],
            { prepare: true },
          );
          // Delete tax lot originals
          await cassandraService.client.execute(
            `DELETE FROM tax_lot_originals WHERE wallet_address = ? AND token_symbol = ?`,
            [wallet, tokenSymbol],
            { prepare: true },
          );
          // Delete disposals
          await cassandraService.client.execute(
            `DELETE FROM disposals WHERE wallet_address = ? AND token_symbol = ?`,
            [wallet, tokenSymbol],
            { prepare: true },
          );
          lotsDeleted++;
          disposalsDeleted++;
        } catch (e) {
          // Ignore errors for tokens/tables that don't exist
        }
      }
    }

    await cassandraService.disconnect();

    console.log(`✅ Cleared cost basis data for group ${groupId}`);

    res.json({
      success: true,
      message: "Cost basis data cleared",
      groupId,
      wallets: group.wallets,
      tokensCleared: commonTokens,
    });
  } catch (error) {
    console.error("Error clearing cost basis data:", error);
    res.status(500).json({
      error: "Failed to clear cost basis data",
      message: error.message,
    });
  }
});

/**
 * Clear all indexed data for a wallet group (transactions, cost basis, etc.)
 * DELETE /api/admin/wallet-groups/:groupId/data
 */
app.delete(
  "/api/admin/wallet-groups/:groupId/data",
  isAdmin,
  async (req, res) => {
    try {
      const { groupId } = req.params;

      const cassandraService = new CassandraArTrackerService();
      await cassandraService.connect();

      // Get the group
      const group = await cassandraService.getWalletGroup(groupId);
      if (!group) {
        await cassandraService.disconnect();
        return res
          .status(404)
          .json({ error: "Wallet group not found", groupId });
      }

      console.log(
        `🗑️ Clearing ALL data for group ${groupId} (${group.wallets.length} wallets)`,
      );

      const commonTokens = [
        "AR",
        "wAR",
        "AO",
        "ARIO",
        "PI",
        "qAR",
        "TRUNK2",
        "EXP",
        "KARD",
        "ANT",
        "wUSDC",
        "USDA",
      ];
      const cleared = {
        transactions: 0,
        taxLots: 0,
        disposals: 0,
        indexerState: 0,
      };

      for (const wallet of group.wallets) {
        // Clear unified transactions
        try {
          await cassandraService.client.execute(
            `DELETE FROM unified_transactions WHERE wallet_address = ?`,
            [wallet],
            { prepare: true },
          );
          cleared.transactions++;
        } catch (e) {
          /* ignore */
        }

        // Clear unified transactions originals
        try {
          await cassandraService.client.execute(
            `DELETE FROM unified_transactions_originals WHERE wallet_address = ?`,
            [wallet],
            { prepare: true },
          );
          cleared.transactions++;
        } catch (e) {
          /* ignore */
        }

        // Clear indexer state
        try {
          await cassandraService.client.execute(
            `DELETE FROM indexer_state WHERE wallet_address = ?`,
            [wallet],
            { prepare: true },
          );
          cleared.indexerState++;
        } catch (e) {
          /* ignore */
        }

        // Clear tax lots and disposals
        for (const tokenSymbol of commonTokens) {
          try {
            await cassandraService.client.execute(
              `DELETE FROM tax_lots WHERE wallet_address = ? AND token_symbol = ?`,
              [wallet, tokenSymbol],
              { prepare: true },
            );
            await cassandraService.client.execute(
              `DELETE FROM tax_lot_originals WHERE wallet_address = ? AND token_symbol = ?`,
              [wallet, tokenSymbol],
              { prepare: true },
            );
            await cassandraService.client.execute(
              `DELETE FROM disposals WHERE wallet_address = ? AND token_symbol = ?`,
              [wallet, tokenSymbol],
              { prepare: true },
            );
            cleared.taxLots++;
            cleared.disposals++;
          } catch (e) {
            /* ignore */
          }
        }
      }

      // Clear cached profiles for these wallets
      try {
        const profilesCleared = await cassandraService.clearProfilesForWallets(
          group.wallets,
        );
        cleared.profiles = profilesCleared;
        if (profilesCleared > 0) {
          console.log(`   🗑️ Cleared ${profilesCleared} cached profile(s)`);
        }
      } catch (e) {
        console.log(`   ⚠️ Could not clear profiles: ${e.message}`);
      }

      // Reset wallet group status
      await cassandraService.updateWalletGroup(groupId, {
        status: "pending",
        lastIndexedAt: null,
        lastIndexStatus: null,
        transactionCount: 0,
      });

      await cassandraService.disconnect();

      console.log(`✅ Cleared ALL data for group ${groupId}`);

      res.json({
        success: true,
        message: "All wallet group data cleared",
        groupId,
        wallets: group.wallets,
        cleared,
      });
    } catch (error) {
      console.error("Error clearing wallet group data:", error);
      res.status(500).json({
        error: "Failed to clear wallet group data",
        message: error.message,
      });
    }
  },
);

/**
 * View raw transactions for debugging
 * GET /api/admin/transactions/:groupId
 */
app.get("/api/admin/transactions/:groupId", isAdmin, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { limit = 50, taxYear, type } = req.query;

    const cassandraService = new CassandraArTrackerService();
    await cassandraService.connect();

    // Get the group
    const group = await cassandraService.getWalletGroup(groupId);
    if (!group) {
      await cassandraService.disconnect();
      return res.status(404).json({ error: "Wallet group not found", groupId });
    }

    const options = {};
    if (taxYear) {
      options.startDate = `${taxYear}-01-01`;
      options.endDate = `${taxYear}-12-31`;
    }

    const transactions =
      await cassandraService.getUnifiedTransactionsMultiWallet(
        group.wallets,
        options,
      );

    let filtered = transactions;
    if (type) {
      filtered = transactions.filter((tx) => tx.type === type);
    }

    // Group by type for summary
    const byType = {};
    for (const tx of transactions) {
      byType[tx.type] = (byType[tx.type] || 0) + 1;
    }

    await cassandraService.disconnect();

    res.json({
      success: true,
      groupId,
      totalTransactions: transactions.length,
      byType,
      sample: filtered.slice(0, parseInt(limit)).map((tx) => ({
        txId: tx.txId,
        type: tx.type,
        token: tx.tokenSymbol,
        amount: tx.amountHuman,
        priceUSD: tx.priceUSD,
        valueUSD: tx.valueUSD,
        timestamp: tx.blockTimestamp,
        date: tx.blockTimestamp
          ? new Date(tx.blockTimestamp * 1000).toISOString()
          : null,
        source: tx.source,
      })),
    });
  } catch (error) {
    console.error("Error fetching transactions:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch transactions", message: error.message });
  }
});

// ============================================================================
// INITIAL BALANCE CALCULATION
// ============================================================================

/**
 * Calculate the initial (pre-indexing) token balance for a wallet.
 * Works backwards: current on-chain balance minus net indexed activity.
 *
 * Data sources (merged, deduplicated by txId):
 *   1. Unified transactions table (AR L1, AO token transfers, DEX swaps)
 *   2. Distribution tables (ao_distributions, pi_distributions) — stored separately
 *
 * GET /api/admin/initial-balance/:wallet?tokens=AO,PI
 * tokens query param: "AO", "PI", or "AO,PI" (default: both)
 */
app.get("/api/admin/initial-balance/:wallet", isAdmin, async (req, res) => {
  const TOKEN_CONFIG = {
    AO: {
      processId: "0syT13r0s0tgPmIed95bJnuSqaD29HQNN8D3ElLSrsc",
      decimals: 12,
      symbol: "AO",
    },
    PI: {
      processId: "4hXj_E-5fAKmo4E8KjgQvuDJKAFk9P2grhycVmISDLs",
      decimals: 12,
      symbol: "PI",
    },
  };

  try {
    const { wallet } = req.params;
    if (!wallet || wallet.length < 10) {
      return res.status(400).json({ error: "Invalid wallet address" });
    }

    const tokensParam = (req.query.tokens || "AO,PI").toUpperCase();
    const requestedTokens = tokensParam.split(",").map((t) => t.trim());
    const invalid = requestedTokens.filter((t) => !TOKEN_CONFIG[t]);
    if (invalid.length) {
      return res.status(400).json({
        error: `Invalid token(s): ${invalid.join(", ")}. Supported: AO, PI`,
      });
    }

    // 1. Fetch unified transactions from ar_tax_tracker
    const cassandraService = new CassandraArTrackerService();
    await cassandraService.connect();
    let allTransactions;
    try {
      allTransactions = await cassandraService.getUnifiedTransactions(
        wallet,
        {},
      );
    } finally {
      await cassandraService.disconnect();
    }

    // 2. Fetch distributions from dedicated distribution keyspaces
    const distributionService = new DistributionService({ verbose: false });
    let distributions = [];
    try {
      await distributionService.connect();
      distributions = await distributionService.fetchAllDistributions(wallet, {});
      await distributionService.disconnect();
    } catch (e) {
      console.warn(
        `[initial-balance] Distribution fetch warning: ${e.message}`,
      );
    }

    // 3. Merge: deduplicate by txId, distributions fill gaps not in unified table
    const seenTxIds = new Set();
    for (const tx of allTransactions) {
      if (tx.txId) seenTxIds.add(tx.txId);
    }
    let distAdded = 0;
    for (const dist of distributions) {
      if (dist.txId && seenTxIds.has(dist.txId)) continue;
      if (dist.txId) seenTxIds.add(dist.txId);
      allTransactions.push({
        type: "DISTRIBUTION",
        tokenSymbol: dist.token,
        amountHuman: dist.amountHuman,
        amountUnits: dist.amountUnits,
        txId: dist.txId,
        blockTimestamp: dist.timestamp,
        source: dist.source,
        taxCategory: "INCOME",
        isTaxableEvent: true,
      });
      distAdded++;
    }

    const results = {};

    for (const tokenKey of requestedTokens) {
      const cfg = TOKEN_CONFIG[tokenKey];
      const divisor = Math.pow(10, cfg.decimals);

      // Fetch current on-chain balance via AO CU dryrun
      let currentBalanceRaw = "0";
      try {
        const cuUrl =
          process.env.AO_CU_URL || "https://cu.ao-testnet.xyz";
        const cuResponse = await fetch(`${cuUrl}/dry-run?process-id=${cfg.processId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            Id: "0000000000000000000000000000000000000000001",
            Target: cfg.processId,
            Owner: wallet,
            Data: "",
            Tags: [
              { name: "Action", value: "Balance" },
              { name: "Recipient", value: wallet },
            ],
          }),
        });
        const cuData = await cuResponse.json();
        const messages = cuData?.Messages || [];
        for (const msg of messages) {
          const balTag = (msg.Tags || []).find((t) => t.name === "Balance");
          if (balTag?.value) {
            currentBalanceRaw = balTag.value;
            break;
          }
          if (msg.Data && /^\d+$/.test(msg.Data.trim())) {
            currentBalanceRaw = msg.Data.trim();
            break;
          }
        }
      } catch (e) {
        console.error(
          `[initial-balance] Failed to fetch on-chain balance for ${cfg.symbol}:`,
          e.message,
        );
      }

      // Walk all transactions and compute net change for this token
      let netChangeUnits = BigInt(0);
      let acquisitionCount = 0;
      let disposalCount = 0;
      const breakdown = {
        distributions: BigInt(0),
        receives: BigInt(0),
        sends: BigInt(0),
        swapIn: BigInt(0),
        swapOut: BigInt(0),
        other: BigInt(0),
      };

      // Convert a human-readable decimal string to exact BigInt units
      // e.g. "0.00906155" with 12 decimals -> 9061550000n (no floating point)
      const humanToBigIntUnits = (humanVal, decimals) => {
        const s = String(humanVal);
        const dotIdx = s.indexOf(".");
        if (dotIdx === -1) return BigInt(s) * BigInt(10) ** BigInt(decimals);
        const wholePart = s.slice(0, dotIdx) || "0";
        let fracPart = s.slice(dotIdx + 1);
        if (fracPart.length > decimals) fracPart = fracPart.slice(0, decimals);
        else fracPart = fracPart.padEnd(decimals, "0");
        return BigInt(wholePart) * BigInt(10) ** BigInt(decimals) + BigInt(fracPart);
      };

      // Resolve the exact unit amount from a transaction, preferring raw units
      const resolveUnits = (rawUnits, humanAmount) => {
        if (rawUnits && String(rawUnits) !== "0" && String(rawUnits) !== "null") {
          try {
            return BigInt(rawUnits);
          } catch { /* fall through */ }
        }
        if (humanAmount != null) {
          return humanToBigIntUnits(humanAmount, cfg.decimals);
        }
        return null;
      };

      for (const tx of allTransactions) {
        // DEX_SWAP: check input/output token symbols
        if (tx.type === "DEX_SWAP" && tx.isSwap) {
          if (tx.inputTokenSymbol === cfg.symbol && tx.inputAmountHuman) {
            const units = humanToBigIntUnits(tx.inputAmountHuman, cfg.decimals);
            netChangeUnits -= units;
            disposalCount++;
            breakdown.swapOut += units;
          }
          if (tx.outputTokenSymbol === cfg.symbol && tx.outputAmountHuman) {
            const units = humanToBigIntUnits(tx.outputAmountHuman, cfg.decimals);
            netChangeUnits += units;
            acquisitionCount++;
            breakdown.swapIn += units;
          }
          continue;
        }

        // Non-swap: check primary token
        if (tx.tokenSymbol !== cfg.symbol) continue;

        const units = resolveUnits(tx.amountUnits, tx.amountHuman);
        if (units === null) continue;

        if (tx.type === "DISTRIBUTION") {
          netChangeUnits += units;
          acquisitionCount++;
          breakdown.distributions += units;
        } else if (
          tx.type === "RECEIVE" ||
          tx.type === "SWAP_IN" ||
          tx.type === "BRIDGE_IN" ||
          tx.type === "AIRDROP" ||
          tx.taxCategory === "INCOME"
        ) {
          netChangeUnits += units;
          acquisitionCount++;
          if (tx.type === "RECEIVE") breakdown.receives += units;
          else breakdown.other += units;
        } else if (
          tx.type === "SEND" ||
          tx.type === "SWAP_OUT" ||
          tx.type === "BRIDGE_OUT"
        ) {
          netChangeUnits -= units;
          disposalCount++;
          breakdown.sends += units;
        }
      }

      const currentUnits = BigInt(currentBalanceRaw);
      const initialUnits = currentUnits - netChangeUnits;

      const fmtUnits = (u) => {
        const abs = u < 0n ? -u : u;
        const sign = u < 0n ? "-" : "";
        const whole = abs / BigInt(divisor);
        const frac = abs % BigInt(divisor);
        const fracStr = frac
          .toString()
          .padStart(cfg.decimals, "0")
          .replace(/0+$/, "");
        return `${sign}${whole}${fracStr ? "." + fracStr : ""}`;
      };

      results[cfg.symbol] = {
        currentBalance: fmtUnits(currentUnits) + ` ${cfg.symbol}`,
        currentBalanceRaw: currentBalanceRaw,
        netIndexedChange: fmtUnits(netChangeUnits) + ` ${cfg.symbol}`,
        netIndexedChangeRaw: netChangeUnits.toString(),
        initialBalance: fmtUnits(initialUnits) + ` ${cfg.symbol}`,
        initialBalanceRaw: initialUnits.toString(),
        transactionsCounted: acquisitionCount + disposalCount,
        acquisitions: acquisitionCount,
        disposals: disposalCount,
        dataSources: {
          unifiedTransactions: allTransactions.length - distAdded,
          distributionsAdded: distAdded,
          totalMerged: allTransactions.length,
        },
        breakdown: {
          distributions: fmtUnits(breakdown.distributions),
          receives: fmtUnits(breakdown.receives),
          sends: fmtUnits(breakdown.sends),
          swapIn: fmtUnits(breakdown.swapIn),
          swapOut: fmtUnits(breakdown.swapOut),
          other: fmtUnits(breakdown.other),
        },
      };
    }

    // Return as readable text
    res.setHeader("Content-Type", "text/plain");
    const lines = [`Initial Balance Report for ${wallet}`, ""];
    for (const [symbol, data] of Object.entries(results)) {
      lines.push(`=== ${symbol} ===`);
      lines.push(`Current on-chain balance:   ${data.currentBalance}`);
      lines.push(`Net indexed activity:       ${data.netIndexedChange}`);
      lines.push(`Calculated initial balance: ${data.initialBalance}`);
      lines.push(
        `Transactions counted:       ${data.transactionsCounted} (${data.acquisitions} in, ${data.disposals} out)`,
      );
      lines.push(
        `Data sources:               ${data.dataSources.unifiedTransactions} from unified table, ${data.dataSources.distributionsAdded} from distribution tables`,
      );
      lines.push(`Breakdown:`);
      lines.push(`  Distributions received:   ${data.breakdown.distributions}`);
      lines.push(`  Transfers received:       ${data.breakdown.receives}`);
      lines.push(`  Transfers sent:           ${data.breakdown.sends}`);
      lines.push(`  Swapped in (DEX):         ${data.breakdown.swapIn}`);
      lines.push(`  Swapped out (DEX):        ${data.breakdown.swapOut}`);
      lines.push(`  Other (airdrops, etc.):   ${data.breakdown.other}`);
      lines.push("");
    }
    res.send(lines.join("\n"));
  } catch (error) {
    console.error("Error calculating initial balance:", error);
    res.status(500).json({
      error: "Failed to calculate initial balance",
      message: error.message,
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: "Not found",
    path: req.path,
  });
});

// ============================================================================
// CRON JOBS - AUTOMATIC UPDATES
// ============================================================================

/**
 * Scheduled job: Update all data daily at 1 AM UTC
 * Runs distributions and price updates automatically
 */
const dailyUpdateJob = cron.schedule(
  "0 1 * * *", // At 01:00 UTC every day
  async () => {
    const timestamp = new Date().toISOString();
    console.log(
      `\n⏰ [${timestamp}] Starting scheduled daily update (distributions + prices)...`,
    );

    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    try {
      // Run distributions update
      console.log("📊 Running AO distribution indexer...");
      const aoResult = await execPromise(
        "node src/indexers/ao_distribution_indexer_cassandra.js",
        { cwd: __dirname, maxBuffer: 50 * 1024 * 1024 }, // 50MB buffer
      );

      // Log the detailed output from the script
      if (aoResult.stdout) {
        console.log("📊 AO Distribution Indexer Output:");
        console.log(aoResult.stdout);
      }
      if (aoResult.stderr) {
        console.log("⚠️  AO Distribution Indexer Errors:");
        console.log(aoResult.stderr);
      }

      console.log("✅ AO distributions updated");

      console.log("📊 Running PI distribution indexer...");
      const piResult = await execPromise(
        "node src/indexers/pi_distribution_indexer_cassandra.js",
        { cwd: __dirname, maxBuffer: 50 * 1024 * 1024 }, // 50MB buffer
      );

      // Log the detailed output from the script
      if (piResult.stdout) {
        console.log("📊 PI Distribution Indexer Output:");
        console.log(piResult.stdout);
      }
      if (piResult.stderr) {
        console.log("⚠️  PI Distribution Indexer Errors:");
        console.log(piResult.stderr);
      }

      console.log("✅ PI distributions updated");

      console.log("📊 Running ARIO distribution indexer...");
      const arioResult = await execPromise(
        "node src/indexers/ario_distribution_indexer_cassandra.js",
        { cwd: __dirname, maxBuffer: 50 * 1024 * 1024 }, // 50MB buffer
      );

      // Log the detailed output from the script
      if (arioResult.stdout) {
        console.log("📊 ARIO Distribution Indexer Output:");
        console.log(arioResult.stdout);
      }
      if (arioResult.stderr) {
        console.log("⚠️  ARIO Distribution Indexer Errors:");
        console.log(arioResult.stderr);
      }

      console.log("✅ ARIO distributions updated");

      // Run ARIO gateway indexer (mainnet only, with date range for today)
      console.log("🔐 Running ARIO gateway mainnet indexer...");
      const today = new Date().toISOString().split("T")[0];
      const yesterday = new Date(Date.now() - 86400000)
        .toISOString()
        .split("T")[0];
      const gatewayResult = await execPromise(
        `node src/indexers/ario_gateway_mainnet_indexer.js ${yesterday} ${today}`,
        { cwd: __dirname, maxBuffer: 50 * 1024 * 1024 }, // 50MB buffer
      );

      // Log the detailed output from the script
      if (gatewayResult.stdout) {
        console.log("🔐 ARIO Gateway Mainnet Indexer Output:");
        console.log(gatewayResult.stdout);
      }
      if (gatewayResult.stderr) {
        console.log("⚠️  ARIO Gateway Mainnet Indexer Errors:");
        console.log(gatewayResult.stderr);
      }

      console.log("✅ ARIO gateway actions updated");

      // Run PIXL distribution indexer
      console.log("🎮 Running PIXL distribution indexer...");
      const pixlResult = await execPromise(
        "node src/indexers/pixl_distribution_indexer.js",
        { cwd: __dirname, maxBuffer: 50 * 1024 * 1024 }, // 50MB buffer
      );

      // Log the detailed output from the script
      if (pixlResult.stdout) {
        console.log("🎮 PIXL Distribution Indexer Output:");
        console.log(pixlResult.stdout);
      }
      if (pixlResult.stderr) {
        console.log("⚠️  PIXL Distribution Indexer Errors:");
        console.log(pixlResult.stderr);
      }

      console.log("✅ PIXL distributions updated");

      // Run price updates using the comprehensive job
      console.log("💰 Running comprehensive price update job...");
      const { spawn } = require("child_process");
      const priceUpdateProcess = spawn("node", ["jobs/update-prices.js"], {
        stdio: "inherit", // Stream output in real-time
        cwd: __dirname,
      });

      await new Promise((resolve, reject) => {
        priceUpdateProcess.on("close", (code) => {
          if (code === 0) {
            console.log("✅ Price updates completed");
            resolve();
          } else {
            console.error(`❌ Price update job failed with exit code ${code}`);
            reject(new Error(`Price update process exited with code ${code}`));
          }
        });

        priceUpdateProcess.on("error", (error) => {
          console.error("❌ Price update job failed:", error);
          reject(error);
        });
      });

      console.log(
        `✅ [${new Date().toISOString()}] Scheduled daily update completed successfully!\n`,
      );
    } catch (error) {
      console.error(
        `❌ [${new Date().toISOString()}] Scheduled daily update failed:`,
        error.message,
      );
    }
  },
  {
    scheduled: true,
    timezone: "UTC",
  },
);

console.log("⏰ Cron job scheduled: Daily update at 1:00 AM UTC");

/**
 * Scheduled job: DEX Price Indexer - hourly incremental updates
 * Indexes new DEX swaps for price data
 */
const dexPriceIndexerJob = cron.schedule(
  "0 * * * *", // At minute 0 of every hour
  async () => {
    const timestamp = new Date().toISOString();
    console.log(
      `\n⏰ [${timestamp}] Starting scheduled DEX price indexer (hourly)...`,
    );

    try {
      updateJobStatus("dex-price-indexer", "running");

      const indexer = new DEXPriceIndexer({
        keyspace: CONFIG.PRICE_DB.keyspace,
        contactPoints: CONFIG.PRICE_DB.contactPoints,
        localDataCenter: CONFIG.PRICE_DB.localDataCenter,
      });

      await indexer.connect();
      await indexer.runIncrementalUpdate();
      await indexer.disconnect();

      updateJobStatus("dex-price-indexer", "completed");
      console.log(
        `✅ [${new Date().toISOString()}] DEX price indexer completed successfully!\n`,
      );
    } catch (error) {
      console.error(
        `❌ [${new Date().toISOString()}] DEX price indexer failed:`,
        error.message,
      );
      updateJobStatus("dex-price-indexer", "error", error);
    }
  },
  {
    scheduled: true,
    timezone: "UTC",
  },
);

console.log("⏰ Cron job scheduled: DEX price indexer hourly at :00");

/**
 * Scheduled job: Fiat Rate Indexer - daily at 2 AM UTC
 * Updates USD to fiat conversion rates
 */
const fiatRateIndexerJob = cron.schedule(
  "0 2 * * *", // At 02:00 UTC every day
  async () => {
    const timestamp = new Date().toISOString();
    console.log(
      `\n⏰ [${timestamp}] Starting scheduled fiat rate indexer (daily)...`,
    );

    try {
      updateJobStatus("fiat-rate-indexer", "running");

      const fiatService = new FiatConversionService({
        keyspace: CONFIG.PRICE_DB.keyspace,
        contactPoints: CONFIG.PRICE_DB.contactPoints,
        localDataCenter: CONFIG.PRICE_DB.localDataCenter,
      });

      await fiatService.connect();
      await fiatService.runIncrementalUpdate();
      await fiatService.disconnect();

      updateJobStatus("fiat-rate-indexer", "completed");
      console.log(
        `✅ [${new Date().toISOString()}] Fiat rate indexer completed successfully!\n`,
      );
    } catch (error) {
      console.error(
        `❌ [${new Date().toISOString()}] Fiat rate indexer failed:`,
        error.message,
      );
      updateJobStatus("fiat-rate-indexer", "error", error);
    }
  },
  {
    scheduled: true,
    timezone: "UTC",
  },
);

console.log("⏰ Cron job scheduled: Fiat rate indexer daily at 2:00 AM UTC");

/**
 * Scheduled job: Wallet Group Incremental Indexer - every 6 hours
 * Checks for wallet groups due for re-indexing and updates them
 */
const walletGroupIndexerJob = cron.schedule(
  "0 */6 * * *", // Every 6 hours at :00
  async () => {
    const timestamp = new Date().toISOString();
    console.log(
      `\n⏰ [${timestamp}] Starting scheduled wallet group indexer...`,
    );

    try {
      const cassandraService = new CassandraArTrackerService();
      await cassandraService.connect();

      // Get groups that need indexing
      const groupsDue = await cassandraService.getGroupsDueForIndexing();

      if (groupsDue.length === 0) {
        console.log("✅ No wallet groups due for indexing");
        await cassandraService.disconnect();
        return;
      }

      console.log(
        `📊 Found ${groupsDue.length} wallet group(s) due for indexing`,
      );

      // Process each group
      for (const group of groupsDue) {
        try {
          console.log(
            `🔄 Indexing group: ${group.groupId} (${group.wallets.length} wallets)`,
          );

          // Update status
          await cassandraService.updateWalletGroup(group.groupId, {
            status: "indexing",
            lastIndexStatus: "running",
          });

          const historyService = new UnifiedWalletHistoryService({
            cassandraService,
            fullHistory: false, // Incremental updates
          });

          const results = await historyService.fetchCompleteHistory(
            group.wallets,
            {
              fullHistory: false,
            },
          );

          // Update with success
          await cassandraService.updateWalletGroup(group.groupId, {
            status: "active",
            lastIndexedAt: new Date(),
            lastIndexStatus: "completed",
            lastIndexError: null,
            transactionCount: results.unified?.length || 0,
          });

          console.log(
            `✅ Group ${group.groupId}: ${results.unified?.length || 0} transactions indexed`,
          );
        } catch (groupError) {
          console.error(
            `❌ Failed to index group ${group.groupId}:`,
            groupError.message,
          );

          await cassandraService.updateWalletGroup(group.groupId, {
            status: "error",
            lastIndexStatus: "error",
            lastIndexError: groupError.message,
          });
        }
      }

      await cassandraService.disconnect();
      console.log(
        `✅ [${new Date().toISOString()}] Wallet group indexer completed!\n`,
      );
    } catch (error) {
      console.error(
        `❌ [${new Date().toISOString()}] Wallet group indexer failed:`,
        error.message,
      );
    }
  },
  {
    scheduled: true,
    timezone: "UTC",
  },
);

console.log("⏰ Cron job scheduled: Wallet group indexer every 6 hours at :00");

// ============================================================================
// SERVER STARTUP WITH AUTO-SCHEMA INITIALIZATION
// ============================================================================

/**
 * Initialize AR Tracker schema if needed and start server
 */
async function startServer() {
  try {
    // Auto-initialize AR Tracker schema (creates tables if they don't exist)
    console.log("\n🔧 Checking AR Tracker database schema...");
    await initializeArTrackerSchema({ force: false });
    console.log("✅ AR Tracker schema ready\n");
  } catch (error) {
    console.warn(
      "⚠️  AR Tracker schema initialization warning:",
      error.message,
    );
    console.log(
      "   Note: Server will continue but AR Tracker features may be limited",
    );
    console.log(
      "   To manually initialize, run: node admin-utilities/init-ar-tracker-schema.js\n",
    );
  }

  // Start server with extended timeout for long-running operations
  const server = app.listen(PORT, () => {
    console.log(`\n🚀 AO Tax Tracker Server`);
    console.log(`📡 Listening on http://localhost:${PORT}`);
    console.log(`🏥 Health check: http://localhost:${PORT}/health`);
    console.log(`📚 API info: http://localhost:${PORT}/`);
    console.log(`\n⏰ Automated Updates:`);
    console.log(
      `   • Daily at 1:00 AM UTC: AO/PI/ARIO/PIXL Distributions + ARIO Gateway + Prices`,
    );
    console.log(`   • Hourly at :00: DEX price indexer (incremental)`);
    console.log(`   • Daily at 2:00 AM UTC: Fiat rate indexer`);
    console.log(
      `   • Manual triggers available via POST /api/jobs/* endpoints`,
    );
    console.log(`\n📝 One-time Setup:`);
    console.log(
      `   • POST /api/jobs/index-ario-testnet (run once for historical data)`,
    );
    console.log(
      `   • POST /api/jobs/dex-price-indexer (run once for full DEX index)`,
    );
    console.log(`\n✨ Ready to serve requests!\n`);
  });

  // Set server timeouts for long-running operations (PDF/CSV generation with staked tokens)
  // Default Node.js timeout is 2 minutes (120000ms), extending to 10 minutes
  server.timeout = 600000; // 10 minutes
  server.keepAliveTimeout = 620000; // Slightly higher than timeout to prevent race conditions
  server.headersTimeout = 625000; // Must be higher than keepAliveTimeout

  console.log(
    `⏱️  Server timeouts configured: ${
      server.timeout / 1000
    }s (for long-running PDF generation)`,
  );

  return server;
}

// Start the server
startServer().catch((error) => {
  console.error("❌ Failed to start server:", error);
  process.exit(1);
});
