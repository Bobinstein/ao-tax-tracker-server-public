/**
 * Stripe payment handler
 *
 * Watches for successful Stripe payments (webhook), reads metadata (wallet, service, year),
 * inserts authorized wallets into the subscription_cache Cassandra table, and sends
 * Manual-Subscribe to the AO payment process so subscriptions are recorded there too.
 *
 * Expects .env:
 *   STRIPE_SECRET_KEY - Stripe secret key (e.g. sk_test_... for sandbox)
 *   STRIPE_WEBHOOK_SECRET - Webhook signing secret (whsec_...) for verifying webhooks
 *   PAYMENT_PROCESS_ID - AO payment process ID (same as auth.js)
 *   MESSAGE_KEY_FILE - Arweave wallet for signing Manual-Subscribe. One of:
 *     - Raw JSON string (production: wallet object as env value, no processing)
 *     - Base64-encoded wallet JSON (e.g. local .env)
 *     - Path to a file containing wallet JSON
 */

require("dotenv").config();
const Stripe = require("stripe");
const {
  message: aoMessage,
  createDataItemSigner,
} = require("@permaweb/aoconnect");
const {
  initCassandra,
  cacheSubscription,
  insertReferral,
} = require("../utils/auth");
const {
  CassandraArTrackerService,
} = require("./ar-tracker/CassandraArTrackerService");
const { runWalletGroupIndexing } = require("./walletGroupIndexer");

const PAYMENT_PROCESS_ID =
  process.env.PAYMENT_PROCESS_ID ||
  "Oq9HJGXuKMRcAtpOZkM1gRlRIaL2FxP4UdK5tvNulro";

const SERVICE_DISTRIBUTION_REPORT = "Distribution Report";
const SERVICE_FULL_TAX_REPORT = "Full Tax Report";
const VALID_SERVICES = new Set([
  SERVICE_DISTRIBUTION_REPORT,
  SERVICE_FULL_TAX_REPORT,
]);

let stripeClient = null;
let messageSigner = null;

/**
 * Get or create Stripe client (uses STRIPE_SECRET_KEY from .env).
 * @returns {Stripe | null}
 */
function getStripe() {
  if (stripeClient) return stripeClient;
  const key = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!key) {
    console.warn(
      "[Stripe] STRIPE_SECRET_KEY not set; Stripe payment handling disabled",
    );
    return null;
  }
  if (key.startsWith("pk_")) {
    console.error(
      "[Stripe] STRIPE_SECRET_KEY must be a secret key (sk_...), not a publishable key (pk_...). " +
        "Use the secret key from https://dashboard.stripe.com/apikeys and restart the server.",
    );
    return null;
  }
  // Longer timeout (60s) and extra retries to avoid connection/redirect timeouts from server to Stripe API
  stripeClient = new Stripe(key, {
    timeout: 60000,
    maxNetworkRetries: 3,
  });
  return stripeClient;
}

/**
 * Load Arweave wallet for signing AO messages (process Owner).
 * MESSAGE_KEY_FILE can be:
 *   1. Raw JSON string (production): wallet object as env value, parse directly.
 *   2. Base64-encoded wallet JSON (e.g. local .env): decode then parse.
 *   3. File path: path to a file containing wallet JSON.
 * @returns {Promise<object | null>} Wallet object or null if not configured
 */
async function loadMessageWallet() {
  if (messageSigner) return messageSigner;
  const raw = process.env.MESSAGE_KEY_FILE;
  if (!raw) {
    console.warn(
      "[Stripe] MESSAGE_KEY_FILE not set; cannot send Manual-Subscribe to AO process",
    );
    return null;
  }
  const trimmed = raw.trim();
  let wallet;
  try {
    if (trimmed.startsWith("{")) {
      // Raw JSON string (production: wallet JSON as env value, no decoding or file read)
      wallet = JSON.parse(trimmed);
    } else if (
      trimmed.length < 1024 &&
      !raw.includes("\n") &&
      /^[A-Za-z0-9+/=]+$/.test(trimmed)
    ) {
      // Base64-encoded wallet JSON (e.g. local .env)
      wallet = JSON.parse(Buffer.from(trimmed, "base64").toString("utf8"));
    } else {
      // File path to wallet JSON
      const fs = require("fs");
      const path = require("path");
      const resolved = path.isAbsolute(trimmed)
        ? trimmed
        : path.resolve(process.cwd(), trimmed);
      wallet = JSON.parse(fs.readFileSync(resolved, "utf8"));
    }
  } catch (e) {
    console.error(
      "[Stripe] Failed to load MESSAGE_KEY_FILE wallet:",
      e.message,
    );
    return null;
  }
  messageSigner = createDataItemSigner(wallet);
  return messageSigner;
}

/**
 * Extract subscription params from Stripe object metadata.
 * Supports single wallet (metadata.wallet) or multiple (metadata.wallets = JSON array string).
 * @param {Record<string, string>} metadata
 * @returns {{ wallets: string[], service: string, year: string } | null}
 */
function parseMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return null;
  const service =
    metadata.service || metadata.Service || SERVICE_DISTRIBUTION_REPORT;
  const year = metadata.year || metadata.Year;
  if (!year) return null;
  const y = parseInt(String(year), 10);
  if (isNaN(y) || y < 2000 || y > 2100) return null;
  if (VALID_SERVICES && !VALID_SERVICES.has(service)) return null;

  let wallets = [];
  if (metadata.wallets && typeof metadata.wallets === "string") {
    try {
      const parsed = JSON.parse(metadata.wallets);
      if (Array.isArray(parsed)) {
        wallets = parsed
          .filter((w) => w && typeof w === "string" && w.trim())
          .map((w) => w.trim());
      }
    } catch (_) {
      // ignore
    }
  }
  if (wallets.length === 0) {
    const wallet = metadata.wallet || metadata.Wallet;
    if (!wallet || typeof wallet !== "string" || !wallet.trim()) return null;
    wallets = [wallet.trim()];
  }
  return { wallets, service, year: String(y) };
}

/**
 * Insert subscription into Cassandra (subscription_cache.subscriptions).
 * @param {string} wallet
 * @param {string} service
 * @param {string} year
 * @param {number} subscribedAt - Unix timestamp (seconds or ms)
 */
async function insertSubscriptionIntoCassandra(
  wallet,
  service,
  year,
  subscribedAt,
) {
  console.log("[Stripe] Cassandra: initializing and inserting subscription", {
    wallet: `${wallet.slice(0, 8)}...${wallet.slice(-4)}`,
    service,
    year,
    subscribedAt,
  });
  await initCassandra();
  const ts =
    subscribedAt > 1e12 ? Math.floor(subscribedAt / 1000) : subscribedAt;
  await cacheSubscription(wallet, service, year, true, ts);
  console.log("[Stripe] Cassandra: subscription inserted successfully", {
    wallet: `${wallet.slice(0, 8)}...${wallet.slice(-4)}`,
    service,
    year,
  });
}

/**
 * Send Manual-Subscribe to the AO payment process so the process state and HyperBEAM stay in sync.
 * Requires MESSAGE_KEY_FILE to be the process Owner wallet.
 * @param {string} wallet - Arweave address to authorize
 * @param {string} service - e.g. "Distribution Report"
 * @param {string} year - e.g. "2025"
 * @param {number} timestamp - Unix seconds
 * @returns {Promise<{ messageId?: string, error?: string }>}
 */
async function sendManualSubscribeToPaymentProcess(
  wallet,
  service,
  year,
  timestamp,
) {
  console.log("[Stripe] AO: sending Manual-Subscribe to payment process", {
    processId: `${PAYMENT_PROCESS_ID.slice(0, 8)}...`,
    wallet: `${wallet.slice(0, 8)}...${wallet.slice(-4)}`,
    service,
    year,
    timestamp,
  });
  const signer = await loadMessageWallet();
  if (!signer) {
    console.warn(
      "[Stripe] AO: skipped Manual-Subscribe (MESSAGE_KEY_FILE not configured)",
    );
    return { error: "MESSAGE_KEY_FILE not configured" };
  }
  try {
    const { Messages } = await aoMessage({
      process: PAYMENT_PROCESS_ID,
      signer,
      tags: [
        { name: "Action", value: "Manual-Subscribe" },
        { name: "Address", value: wallet },
        { name: "Service", value: service },
        { name: "Year", value: year },
        { name: "Timestamp", value: String(timestamp) },
      ],
    });
    const messageId = Messages?.[0]?.Target ?? Messages?.[0]?.id;
    console.log("[Stripe] AO: Manual-Subscribe sent successfully", {
      messageId: messageId || "(unknown)",
      wallet: `${wallet.slice(0, 8)}...${wallet.slice(-4)}`,
    });
    return { messageId: messageId || "sent" };
  } catch (e) {
    console.error("[Stripe] AO Manual-Subscribe error:", e.message);
    return { error: e.message };
  }
}

/**
 * Handle a successful payment: parse metadata, insert into Cassandra, notify AO process.
 * Idempotent for the same payment intent/session (Cassandra and process handle duplicates).
 *
 * @param {object} payload - Stripe event data (e.g. session or payment_intent)
 * @param {'checkout.session.completed' | 'payment_intent.succeeded'} eventType
 * @returns {Promise<{ success: boolean, wallet?: string, service?: string, year?: string, error?: string, aoError?: string }>}
 */
async function handleSuccessfulPayment(payload, eventType) {
  console.log("[Stripe] handleSuccessfulPayment: start", {
    eventType,
    payloadId: payload.id || payload.payment_intent || "(none)",
    metadataKeys: payload.metadata ? Object.keys(payload.metadata) : [],
  });

  let metadata;
  let subscribedAt = Math.floor(Date.now() / 1000);

  if (eventType === "checkout.session.completed") {
    metadata = payload.metadata || {};
    if (payload.created) subscribedAt = payload.created;
    console.log("[Stripe] handleSuccessfulPayment: checkout.session payload", {
      sessionId: payload.id,
      metadata,
      created: payload.created,
    });
  } else if (eventType === "payment_intent.succeeded") {
    metadata = payload.metadata || {};
    if (payload.created) subscribedAt = payload.created;
    console.log("[Stripe] handleSuccessfulPayment: payment_intent payload", {
      paymentIntentId: payload.id,
      metadata,
      created: payload.created,
    });
  } else {
    console.warn("[Stripe] handleSuccessfulPayment: unsupported event type", {
      eventType,
    });
    return { success: false, error: "Unsupported event type" };
  }

  const params = parseMetadata(metadata);
  if (!params) {
    console.warn(
      "[Stripe] handleSuccessfulPayment: invalid or missing metadata",
      {
        metadata,
        hint: "Expected wallet/wallets, service, year in metadata",
      },
    );
    return {
      success: false,
      error: "Invalid or missing metadata (wallet/wallets, service, year)",
    };
  }
  console.log("[Stripe] handleSuccessfulPayment: parsed params", {
    walletsCount: params.wallets.length,
    service: params.service,
    year: params.year,
  });

  const { wallets, service, year } = params;
  const aoErrors = [];
  let walletGroupIdForReferral = null;

  for (const wallet of wallets) {
    try {
      await insertSubscriptionIntoCassandra(
        wallet,
        service,
        year,
        subscribedAt,
      );
    } catch (e) {
      console.error("[Stripe] Cassandra insert error:", e.message, {
        wallet: `${wallet.slice(0, 8)}...`,
        service,
        year,
      });
      return {
        success: false,
        wallet,
        service,
        year,
        error: e.message,
      };
    }

    const aoResult = await sendManualSubscribeToPaymentProcess(
      wallet,
      service,
      year,
      subscribedAt,
    );
    if (aoResult.error) {
      console.warn(
        "[Stripe] Cassandra updated but AO Manual-Subscribe failed for wallet:",
        aoResult.error,
        { wallet: `${wallet.slice(0, 8)}...` },
      );
      aoErrors.push({
        wallet: wallet.slice(0, 8) + "...",
        error: aoResult.error,
      });
      // Do not return here: we still need to create the wallet group and start indexing for Full Tax Report
    }
  }

  // Full Tax Report: create a wallet group so any wallet in the group can find this subscription
  // (runs even when AO Manual-Subscribe failed above, so group + indexing are never skipped)
  if (service === SERVICE_FULL_TAX_REPORT && wallets.length >= 1) {
    let cassandraService = null;
    try {
      cassandraService = new CassandraArTrackerService();
      await cassandraService.connect();
      const group = await cassandraService.createWalletGroup({
        wallets,
        primaryWallet: wallets[0],
        groupName: `Full Tax Report ${year}`,
        notes: JSON.stringify({ service, year }),
        createdBy: "stripe-webhook",
      });
      walletGroupIdForReferral = group.groupId;
      console.log("[Stripe] handleSuccessfulPayment: wallet group created", {
        groupId: group.groupId,
        walletsCount: wallets.length,
        service,
        year,
      });

      // Trigger full indexing from genesis so reports can be generated (runs in background)
      console.log("[Stripe] Triggering wallet group indexing (background)", {
        groupId: group.groupId,
        fullHistory: true,
      });
      runWalletGroupIndexing(group.groupId, { fullHistory: true }).catch(
        (err) => {
          console.warn(
            "[Stripe] handleSuccessfulPayment: wallet group index start failed:",
            err.message,
          );
        },
      );
    } catch (e) {
      console.warn(
        "[Stripe] handleSuccessfulPayment: wallet group creation failed (subscription still recorded):",
        e.message,
      );
    } finally {
      if (cassandraService) {
        try {
          await cassandraService.disconnect();
        } catch (_) {}
      }
    }
  }

  // Referral tracking: if referrer in metadata, save to referral_tracking (normalize lowercase)
  const referrerId =
    metadata.referrer && String(metadata.referrer).trim()
      ? String(metadata.referrer).trim().slice(0, 200).toLowerCase()
      : null;
  if (referrerId) {
    try {
      await insertReferral({
        referrerId,
        paymentId: payload.id,
        walletId: wallets[0],
        walletGroupId: walletGroupIdForReferral,
        service,
        year,
      });
      console.log("[Stripe] handleSuccessfulPayment: referral recorded", {
        referrerId:
          referrerId.slice(0, 20) + (referrerId.length > 20 ? "..." : ""),
        paymentId: payload.id,
      });
    } catch (e) {
      console.warn(
        "[Stripe] handleSuccessfulPayment: referral insert failed (payment still succeeded):",
        e.message,
      );
    }
  }

  console.log("[Stripe] handleSuccessfulPayment: complete", {
    walletsCount: wallets.length,
    service,
    year,
    aoErrorsCount: aoErrors.length,
  });
  const result = {
    success: true,
    wallets,
    service,
    year,
  };
  if (aoErrors.length > 0) {
    result.aoError = aoErrors[0].error;
    result.aoErrors = aoErrors;
  }
  return result;
}

/**
 * Express-compatible webhook handler. Expects raw body (Buffer) for signature verification.
 * Mount with: app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler)
 *
 * @param {import('express').Request} req - req.body must be raw Buffer
 * @param {import('express').Response} res
 */
async function stripeWebhookHandler(req, res) {
  console.log("[Stripe] Webhook: request received", {
    method: req.method,
    contentType: req.headers["content-type"],
    hasSignature: Boolean(req.headers["stripe-signature"]),
    bodyType: req.body
      ? Buffer.isBuffer(req.body)
        ? "Buffer"
        : typeof req.body
      : "none",
    bodyLength: req.body && Buffer.isBuffer(req.body) ? req.body.length : 0,
  });

  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) {
    console.warn(
      "[Stripe] Webhook: rejected (Stripe or STRIPE_WEBHOOK_SECRET not configured)",
    );
    return res.status(503).send("Stripe or webhook secret not configured");
  }

  const sig = req.headers["stripe-signature"];
  if (!sig) {
    console.warn(
      "[Stripe] Webhook: rejected (missing stripe-signature header)",
    );
    return res.status(400).send("Missing stripe-signature header");
  }

  let event;
  try {
    const body = req.body;
    if (!Buffer.isBuffer(body)) {
      console.warn(
        "[Stripe] Webhook: rejected (body must be raw Buffer, use express.raw() for this route)",
      );
      return res
        .status(400)
        .send("Webhook body must be raw (use express.raw() for this route)");
    }
    event = stripe.webhooks.constructEvent(body, sig, secret);
    console.log("[Stripe] Webhook: signature verified", {
      eventId: event.id,
      eventType: event.type,
      livemode: event.livemode,
    });
  } catch (e) {
    console.warn("[Stripe] Webhook: signature verification failed", {
      error: e.message,
    });
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      console.log("[Stripe] Webhook: processing checkout.session.completed", {
        sessionId: session.id,
        metadata: session.metadata,
      });
      const result = await handleSuccessfulPayment(
        session,
        "checkout.session.completed",
      );
      if (!result.success) {
        console.warn(
          "[Stripe] Webhook: checkout.session.completed handling failed",
          result,
        );
      }
      console.log(
        "[Stripe] Webhook: responding 200 for checkout.session.completed",
        {
          handled: result.success,
        },
      );
      return res.json({ received: true, handled: result });
    }
    case "payment_intent.succeeded": {
      const paymentIntent = event.data.object;
      console.log("[Stripe] Webhook: processing payment_intent.succeeded", {
        paymentIntentId: paymentIntent.id,
        metadata: paymentIntent.metadata,
      });
      const result = await handleSuccessfulPayment(
        paymentIntent,
        "payment_intent.succeeded",
      );
      if (!result.success) {
        console.warn(
          "[Stripe] Webhook: payment_intent.succeeded handling failed",
          result,
        );
      }
      console.log(
        "[Stripe] Webhook: responding 200 for payment_intent.succeeded",
        {
          handled: result.success,
        },
      );
      return res.json({ received: true, handled: result });
    }
    default:
      console.log("[Stripe] Webhook: unhandled event type (ack only)", {
        eventType: event.type,
        eventId: event.id,
      });
      return res.json({ received: true });
  }
}

/** Distribution Report price in cents */
const SUBSCRIPTION_PRICE_CENTS = 5000; // $50.00
/** Full Tax Report: base price in cents (covers 1–5 wallets) */
const FULL_TAX_BASE_CENTS = 20000; // $200.00
/** Full Tax Report: cents per wallet over 5 */
const FULL_TAX_EXTRA_WALLET_CENTS = 1000; // $10.00

/**
 * Create a Stripe Checkout Session for subscription.
 * Expects req.body: { wallet, service?, year?, success_url, cancel_url, additionalWallets? }.
 * Full Tax Report: $200 for 1–5 wallets, then $10 per wallet over 5. total wallets = 1 + additionalWallets.length.
 * Returns { url } or 4xx/5xx.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function createCheckoutSessionHandler(req, res) {
  console.log("[Stripe] createCheckoutSession: request received", {
    hasBody: Boolean(req.body),
    keys: req.body ? Object.keys(req.body) : [],
  });

  const stripe = getStripe();
  if (!stripe) {
    console.warn("[Stripe] createCheckoutSession: Stripe not configured");
    return res.status(503).json({ error: "Stripe not configured" });
  }
  const {
    wallet,
    service,
    year,
    success_url,
    cancel_url,
    additionalWallets,
    referrer,
  } = req.body || {};
  const rawService = (service != null && String(service).trim()) || "";
  const referrerTrimmed =
    referrer != null && String(referrer).trim()
      ? String(referrer).trim().slice(0, 200).toLowerCase()
      : "";
  console.log("[Stripe] createCheckoutSession: parsed", {
    wallet: wallet ? `${String(wallet).slice(0, 8)}...` : null,
    service: rawService || "(default)",
    year: year != null ? String(year) : "(default)",
    hasReferrer: Boolean(referrerTrimmed),
  });
  const w = (wallet && String(wallet).trim()) || null;
  // Normalize service (case-insensitive) to one of the valid values
  const rawLower = rawService.toLowerCase();
  const svc =
    rawLower === SERVICE_FULL_TAX_REPORT.toLowerCase()
      ? SERVICE_FULL_TAX_REPORT
      : rawLower === SERVICE_DISTRIBUTION_REPORT.toLowerCase()
        ? SERVICE_DISTRIBUTION_REPORT
        : rawService || SERVICE_DISTRIBUTION_REPORT;
  const yr = (year && String(year)) || String(new Date().getUTCFullYear());
  const yNum = parseInt(yr, 10);
  const extra = Array.isArray(additionalWallets)
    ? additionalWallets
        .filter((x) => x != null && String(x).trim())
        .map((x) => String(x).trim())
    : [];
  if (!w) {
    console.warn(
      "[Stripe] createCheckoutSession: validation failed (wallet required)",
    );
    return res.status(400).json({ error: "wallet is required" });
  }
  if (isNaN(yNum) || yNum < 2000 || yNum > 2100) {
    console.warn(
      "[Stripe] createCheckoutSession: validation failed (invalid year)",
      { year: yr },
    );
    return res.status(400).json({ error: "year must be 2000-2100" });
  }
  if (VALID_SERVICES && !VALID_SERVICES.has(svc)) {
    console.warn(
      "[Stripe] createCheckoutSession: validation failed (invalid service)",
      { service: svc },
    );
    return res.status(400).json({ error: "invalid service" });
  }
  const success = success_url && String(success_url).trim();
  const cancel = cancel_url && String(cancel_url).trim();
  if (!success || !cancel) {
    console.warn(
      "[Stripe] createCheckoutSession: validation failed (success_url and cancel_url required)",
    );
    return res
      .status(400)
      .json({ error: "success_url and cancel_url are required" });
  }

  const allWallets = [w, ...extra];
  const totalCents =
    svc === SERVICE_FULL_TAX_REPORT
      ? FULL_TAX_BASE_CENTS +
        FULL_TAX_EXTRA_WALLET_CENTS * Math.max(0, allWallets.length - 5)
      : SUBSCRIPTION_PRICE_CENTS;
  const metadata = {
    ...(allWallets.length > 1
      ? { wallets: JSON.stringify(allWallets) }
      : { wallet: w }),
    service: svc,
    year: yr,
    ...(referrerTrimmed ? { referrer: referrerTrimmed } : {}),
  };

  console.log("[Stripe] createCheckoutSession: creating session", {
    wallet: `${w.slice(0, 8)}...${w.slice(-4)}`,
    service: svc,
    year: yr,
    additionalWallets: extra.length,
    totalCents,
    success_url: success.slice(0, 60) + (success.length > 60 ? "..." : ""),
    cancel_url: cancel.slice(0, 60) + (cancel.length > 60 ? "..." : ""),
  });
  console.log("[Stripe] createCheckoutSession: metadata to attach", {
    keys: Object.keys(metadata),
    walletsCount: allWallets.length,
  });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: totalCents,
            product_data: {
              name: `${svc} (${yr})`,
              description:
                allWallets.length > 1
                  ? `Subscription for ${svc} (${allWallets.length} wallets) for calendar year ${yr}.`
                  : `Subscription for ${svc} for calendar year ${yr}. Wallet: ${w.slice(0, 8)}...${w.slice(-4)}`,
            },
          },
        },
      ],
      success_url: success,
      cancel_url: cancel,
      metadata,
      // So the Payment (PaymentIntent) in Stripe dashboard and webhooks also has metadata
      payment_intent_data: {
        metadata,
      },
    });
    console.log("[Stripe] createCheckoutSession: session created", {
      sessionId: session.id,
      url: session.url ? `${session.url.slice(0, 50)}...` : "(none)",
    });
    return res.json({ url: session.url });
  } catch (e) {
    const isConnectionError =
      e.type === "StripeConnectionError" ||
      (e.message && /connection to Stripe|retried|timeout/i.test(e.message));
    const userMessage = isConnectionError
      ? "Connection to Stripe timed out. Please try again in a moment. If it keeps happening, the server may be unable to reach Stripe (check firewall/network)."
      : e.message || "Failed to create checkout session";
    console.error("[Stripe] createCheckoutSession error:", e.message, {
      wallet: `${w.slice(0, 8)}...`,
      service: svc,
      year: yr,
      type: e.type,
    });
    return res.status(500).json({ error: userMessage });
  }
}

module.exports = {
  getStripe,
  handleSuccessfulPayment,
  stripeWebhookHandler,
  createCheckoutSessionHandler,
  parseMetadata,
  PAYMENT_PROCESS_ID,
};
