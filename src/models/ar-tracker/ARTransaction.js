/**
 * ARTransaction Model
 *
 * Normalized model for Arweave L1 transactions with tax-relevant fields.
 * Handles both basic AR transfers and SmartWeave contract interactions.
 *
 * Transaction Types:
 * - RECEIVE: Incoming AR (acquisition - taxable event, establishes cost basis)
 * - SEND: Outgoing AR (disposal - taxable event, triggers gain/loss)
 * - INTERNAL_TRANSFER: Between user's own wallets (NOT taxable, but track fees)
 * - DATA_UPLOAD: Upload data to blockweave (fee is added to cost basis)
 * - SMARTWEAVE_INTERACTION: SmartWeave contract call (fee is added to cost basis)
 * - SMARTWEAVE_TOKEN_TRANSFER: SmartWeave token transfer (may be taxable)
 * - SMARTWEAVE_DEX_SWAP: SmartWeave DEX swap (taxable trade)
 * - SMARTWEAVE_STAKING: SmartWeave staking operation (complex tax treatment)
 * - MINING_REWARD: AR from mining (taxable income at FMV on receipt)
 * - GATEWAY_REWARD: AR from running a gateway (taxable income)
 *
 * SmartWeave Transaction Identification:
 * SmartWeave transactions are identified by the following tag patterns:
 * - App-Name: "SmartWeaveAction" or "SmartWeaveContract"
 * - Contract: Transaction ID of the contract being interacted with
 * - Input: JSON string containing the function call and parameters
 *
 * The Input.function field determines the specific SmartWeave operation type
 * for tax classification purposes.
 *
 * @module models/ARTransaction
 */

// Transaction type enumeration
// These represent the basic internal classification of L1 transactions
const TransactionType = {
  RECEIVE: "RECEIVE",
  SEND: "SEND",
  INTERNAL_TRANSFER: "INTERNAL_TRANSFER",
  DATA_UPLOAD: "DATA_UPLOAD",
  SMARTWEAVE_INTERACTION: "SMARTWEAVE_INTERACTION",
  SMARTWEAVE_TOKEN_TRANSFER: "SMARTWEAVE_TOKEN_TRANSFER",
  SMARTWEAVE_DEX_SWAP: "SMARTWEAVE_DEX_SWAP",
  SMARTWEAVE_STAKING: "SMARTWEAVE_STAKING",
  SMARTWEAVE_PURCHASE: "SMARTWEAVE_PURCHASE",
  MINING_REWARD: "MINING_REWARD",
  GATEWAY_REWARD: "GATEWAY_REWARD",
  UNKNOWN: "UNKNOWN",
};

// SmartWeave function to transaction type mapping
// Used to classify SmartWeave interactions into specific types
const SMARTWEAVE_FUNCTION_MAP = {
  // Token operations that may be taxable
  transfer: TransactionType.SMARTWEAVE_TOKEN_TRANSFER,
  transferTokens: TransactionType.SMARTWEAVE_TOKEN_TRANSFER,
  safeTransferFrom: TransactionType.SMARTWEAVE_TOKEN_TRANSFER,

  // DEX operations
  swap: TransactionType.SMARTWEAVE_DEX_SWAP,
  exchange: TransactionType.SMARTWEAVE_DEX_SWAP,
  createOrder: TransactionType.SMARTWEAVE_DEX_SWAP,
  fillOrder: TransactionType.SMARTWEAVE_DEX_SWAP,

  // Staking operations
  delegateStake: TransactionType.SMARTWEAVE_STAKING,
  increaseOperatorStake: TransactionType.SMARTWEAVE_STAKING,
  stake: TransactionType.SMARTWEAVE_STAKING,
  unstake: TransactionType.SMARTWEAVE_STAKING,
  withdrawStake: TransactionType.SMARTWEAVE_STAKING,

  // Purchase operations
  buyRecord: TransactionType.SMARTWEAVE_PURCHASE,
  buy: TransactionType.SMARTWEAVE_PURCHASE,
  purchase: TransactionType.SMARTWEAVE_PURCHASE,
};

// Fee type enumeration
const FeeType = {
  TRANSFER_FEE: "TRANSFER_FEE", // Fee for AR transfer
  DATA_UPLOAD_FEE: "DATA_UPLOAD_FEE", // Fee for data storage
  SMARTWEAVE_FEE: "SMARTWEAVE_FEE", // Fee for contract interaction
  BUNDLER_FEE: "BUNDLER_FEE", // Fee paid to bundlers (Irys/Turbo)
};

class ARTransaction {
  /**
   * Create an AR transaction record
   * @param {Object} config
   */
  constructor(config) {
    // Core identification
    this.txId = config.txId; // Arweave transaction ID
    this.blockHeight = config.blockHeight;
    this.blockTimestamp = config.blockTimestamp; // Unix timestamp (seconds)

    // Parties involved
    this.ownerAddress = config.ownerAddress; // Transaction creator
    this.targetAddress = config.targetAddress; // Recipient (if transfer)

    // Transaction classification (basic type for internal use)
    this.type = config.type || TransactionType.UNKNOWN;
    this.isInternalTransfer = config.isInternalTransfer || false;

    // Tax classification (user-editable, maps to TaxClassification.TransactionTypes)
    // This is the field that determines actual tax treatment
    this.taxClassification =
      config.taxClassification || this.mapToTaxClassification();

    // User override tracking
    this.isUserOverridden = config.isUserOverridden || false;
    this.originalTaxClassification = config.originalTaxClassification || null;
    this.overrideReason = config.overrideReason || null;
    this.overriddenAt = config.overriddenAt || null;
    this.overriddenBy = config.overriddenBy || null;

    // Amounts (all in Winston - 1 AR = 10^12 Winston)
    this.quantityWinston = config.quantityWinston || "0";
    this.rewardWinston = config.rewardWinston || "0"; // Transaction fee paid

    // Derived amounts in AR
    this.quantityAR = this.winstonToAR(this.quantityWinston);
    this.rewardAR = this.winstonToAR(this.rewardWinston);

    // Data upload info (if applicable)
    this.dataSize = config.dataSize || 0;
    this.contentType = config.contentType || null;

    // SmartWeave info (if applicable)
    // These fields capture SmartWeave contract interaction details
    this.appName = config.appName || null;
    this.contractId = config.contractId || null;
    this.input = config.input || null; // Raw Input tag value (JSON string)
    this.inputParsed = config.inputParsed || null; // Parsed Input object
    this.swFunction = config.swFunction || null; // SmartWeave function name
    this.swFunctionParams = config.swFunctionParams || null; // Function parameters

    // Bundle info - important for tracking bundled transactions (ANS-104)
    // Bundled transactions have fees paid by the bundler, not the user
    this.bundledIn = config.bundledIn || null; // Parent bundle tx ID if bundled
    this.isBundled = config.isBundled || false; // True if this is a bundled data item
    this.bundlerAddress = config.bundlerAddress || null; // Address that paid for bundling

    // Tax-relevant fields
    this.feeType = config.feeType || null;
    this.isTaxableEvent = this.determineTaxability();
    this.taxEventType = this.determineTaxEventType();

    // Price data (to be filled from price index)
    this.priceUSD = config.priceUSD || null; // AR price in USD at tx time
    this.valueUSD = config.valueUSD || null; // Total value in USD
    this.feeValueUSD = config.feeValueUSD || null; // Fee value in USD

    // For cost basis tracking
    this.costBasisUSD = config.costBasisUSD || null;
    this.proceedsUSD = config.proceedsUSD || null;
    this.gainLossUSD = config.gainLossUSD || null;
    this.holdingPeriod = config.holdingPeriod || null; // 'short' or 'long'

    // Metadata
    this.tags = config.tags || [];
    this.rawTransaction = config.rawTransaction || null;

    // Timestamps
    this.processedAt = new Date();
  }

  /**
   * Convert Winston to AR
   * @param {string|number} winston
   * @returns {number}
   */
  winstonToAR(winston) {
    return Number(winston) / 1e12;
  }

  /**
   * Get transaction date as Date object
   * @returns {Date}
   */
  getDate() {
    return new Date(this.blockTimestamp * 1000);
  }

  /**
   * Get formatted date string
   * @returns {string}
   */
  getDateString() {
    if (!this.blockTimestamp) return null;
    try {
      return this.getDate().toISOString().split("T")[0];
    } catch (error) {
      return null;
    }
  }

  /**
   * Determine if this is a taxable event
   * @returns {boolean}
   */
  determineTaxability() {
    switch (this.type) {
      case TransactionType.RECEIVE:
        return true; // Acquisition
      case TransactionType.SEND:
        return !this.isInternalTransfer; // Disposal (unless internal)
      case TransactionType.INTERNAL_TRANSFER:
        return false; // Not taxable
      case TransactionType.DATA_UPLOAD:
        return false; // Fee adds to basis, not taxable event itself
      case TransactionType.SMARTWEAVE_INTERACTION:
        return false; // Fee adds to basis
      case TransactionType.MINING_REWARD:
        return true; // Taxable income
      case TransactionType.GATEWAY_REWARD:
        return true; // Taxable income
      default:
        return false;
    }
  }

  /**
   * Determine the type of tax event
   * @returns {string|null}
   */
  determineTaxEventType() {
    if (!this.isTaxableEvent) {
      return null;
    }

    switch (this.type) {
      case TransactionType.RECEIVE:
        return "ACQUISITION";
      case TransactionType.SEND:
        return "DISPOSAL";
      case TransactionType.MINING_REWARD:
      case TransactionType.GATEWAY_REWARD:
        return "INCOME";
      default:
        return null;
    }
  }

  /**
   * Map internal TransactionType to TaxClassification type ID
   * This provides the initial automatic classification
   * @returns {string}
   */
  mapToTaxClassification() {
    // Map based on transaction characteristics
    switch (this.type) {
      case TransactionType.RECEIVE:
        // Could be purchase, trade, gift, etc. - default to trade acquisition
        return "TRADE_ACQUISITION";

      case TransactionType.SEND:
        if (this.isInternalTransfer) {
          return "INTERNAL_TRANSFER";
        }
        // Could be sale, trade, gift, payment, etc. - default to trade disposal
        return "TRADE_DISPOSAL";

      case TransactionType.INTERNAL_TRANSFER:
        return "INTERNAL_TRANSFER";

      case TransactionType.DATA_UPLOAD:
        return "DATA_UPLOAD_FEE";

      case TransactionType.SMARTWEAVE_INTERACTION:
        return "CONTRACT_INTERACTION_FEE";

      case TransactionType.SMARTWEAVE_TOKEN_TRANSFER:
        // Token transfers within SmartWeave contracts may be disposals or acquisitions
        // Default to disposal since sender pays the fee
        return "TRADE_DISPOSAL";

      case TransactionType.SMARTWEAVE_DEX_SWAP:
        return "DEX_SWAP";

      case TransactionType.SMARTWEAVE_STAKING:
        return "STAKING_DEPOSIT";

      case TransactionType.SMARTWEAVE_PURCHASE:
        return "PAYMENT_FOR_GOODS";

      case TransactionType.MINING_REWARD:
        return "MINING_REWARD";

      case TransactionType.GATEWAY_REWARD:
        return "GATEWAY_REWARD";

      default:
        return "UNKNOWN";
    }
  }

  /**
   * Apply user override to transaction classification
   * @param {string} newClassification - New TaxClassification type ID
   * @param {string} [reason] - Reason for override
   * @param {string} [userId] - ID of user making the override
   */
  setUserOverride(newClassification, reason = null, userId = "user") {
    // Store original if this is the first override
    if (!this.isUserOverridden) {
      this.originalTaxClassification = this.taxClassification;
    }

    this.taxClassification = newClassification;
    this.isUserOverridden = true;
    this.overrideReason = reason;
    this.overriddenAt = new Date();
    this.overriddenBy = userId;

    // Recalculate tax implications based on new classification
    this.recalculateTaxImplications();
  }

  /**
   * Revert user override to original classification
   */
  revertUserOverride() {
    if (!this.isUserOverridden || !this.originalTaxClassification) {
      return;
    }

    this.taxClassification = this.originalTaxClassification;
    this.isUserOverridden = false;
    this.originalTaxClassification = null;
    this.overrideReason = null;
    this.overriddenAt = null;
    this.overriddenBy = null;

    // Recalculate tax implications
    this.recalculateTaxImplications();
  }

  /**
   * Recalculate tax implications based on current classification
   * This is called when classification changes
   */
  recalculateTaxImplications() {
    // Import would cause circular dependency, so we use the classification directly
    const disposalTypes = [
      "SALE",
      "TRADE_DISPOSAL",
      "GIFT_SENT",
      "DONATION",
      "PAYMENT_FOR_GOODS",
      "PAYMENT_FOR_SERVICES",
      "LOST_OR_STOLEN",
      "MARGIN_FEE",
    ];

    const incomeTypes = [
      "AIRDROP",
      "MINING_REWARD",
      "STAKING_REWARD",
      "GATEWAY_REWARD",
      "HARD_FORK",
      "INTEREST_INCOME",
    ];

    const acquisitionTypes = [
      "PURCHASE",
      "TRADE_ACQUISITION",
      "GIFT_RECEIVED",
      "INHERITANCE",
      "REBATE_OR_CASHBACK",
    ];

    const nonTaxableTypes = [
      "INTERNAL_TRANSFER",
      "DEPOSIT_TO_EXCHANGE",
      "WITHDRAWAL_FROM_EXCHANGE",
      "WRAP_UNWRAP",
      "BRIDGE_TRANSFER",
      "FAILED_TRANSACTION",
      "SPAM_AIRDROP",
    ];

    // Update taxability
    if (nonTaxableTypes.includes(this.taxClassification)) {
      this.isTaxableEvent = false;
      this.taxEventType = null;
    } else if (disposalTypes.includes(this.taxClassification)) {
      this.isTaxableEvent = true;
      this.taxEventType = "DISPOSAL";
    } else if (incomeTypes.includes(this.taxClassification)) {
      this.isTaxableEvent = true;
      this.taxEventType = "INCOME";
    } else if (acquisitionTypes.includes(this.taxClassification)) {
      this.isTaxableEvent = true;
      this.taxEventType = "ACQUISITION";
    }
  }

  /**
   * Check if this transaction has a deductible fee
   * @returns {boolean}
   */
  hasDeductibleFee() {
    return (
      Number(this.rewardWinston) > 0 &&
      [
        TransactionType.DATA_UPLOAD,
        TransactionType.SMARTWEAVE_INTERACTION,
        TransactionType.INTERNAL_TRANSFER,
      ].includes(this.type)
    );
  }

  /**
   * Calculate the total cost for this transaction (for cost basis purposes)
   * @returns {number} Total cost in AR
   */
  getTotalCostAR() {
    return this.quantityAR + this.rewardAR;
  }

  /**
   * Check if acquisition date qualifies for long-term gains (>1 year)
   * @param {Date} disposalDate - Date of disposal
   * @returns {boolean}
   */
  isLongTermHolding(disposalDate) {
    const acquisitionDate = this.getDate();
    const oneYearMs = 365 * 24 * 60 * 60 * 1000;
    return disposalDate.getTime() - acquisitionDate.getTime() > oneYearMs;
  }

  /**
   * Set USD values from price data
   * @param {number} priceUSD - AR price in USD at transaction time
   */
  setPriceData(priceUSD) {
    this.priceUSD = priceUSD;
    this.valueUSD = this.quantityAR * priceUSD;
    this.feeValueUSD = this.rewardAR * priceUSD;
  }

  /**
   * Serialize for storage/export
   * @returns {Object}
   */
  toJSON() {
    return {
      txId: this.txId,
      blockHeight: this.blockHeight,
      blockTimestamp: this.blockTimestamp,
      date: this.getDateString(),
      ownerAddress: this.ownerAddress,
      targetAddress: this.targetAddress,
      type: this.type,
      isInternalTransfer: this.isInternalTransfer,

      // Tax classification (user-editable)
      taxClassification: this.taxClassification,
      isUserOverridden: this.isUserOverridden,
      originalTaxClassification: this.originalTaxClassification,
      overrideReason: this.overrideReason,
      overriddenAt: this.overriddenAt?.toISOString() || null,
      overriddenBy: this.overriddenBy,

      // Amounts
      quantityWinston: this.quantityWinston,
      quantityAR: this.quantityAR,
      rewardWinston: this.rewardWinston,
      rewardAR: this.rewardAR,

      // Additional data
      dataSize: this.dataSize,
      contentType: this.contentType,
      appName: this.appName,
      contractId: this.contractId,
      feeType: this.feeType,

      // Tax implications (derived from taxClassification)
      isTaxableEvent: this.isTaxableEvent,
      taxEventType: this.taxEventType,

      // USD values
      priceUSD: this.priceUSD,
      valueUSD: this.valueUSD,
      feeValueUSD: this.feeValueUSD,
      costBasisUSD: this.costBasisUSD,
      proceedsUSD: this.proceedsUSD,
      gainLossUSD: this.gainLossUSD,
      holdingPeriod: this.holdingPeriod,

      processedAt: this.processedAt?.toISOString() || new Date().toISOString(),
    };
  }

  /**
   * Parse SmartWeave Input tag to extract function and parameters
   *
   * @param {string} inputStr - JSON string from Input tag
   * @returns {Object|null} Parsed input or null if invalid
   */
  static parseSmartWeaveInput(inputStr) {
    if (!inputStr) return null;

    try {
      const parsed = JSON.parse(inputStr);
      return {
        function: parsed.function || null,
        params: parsed,
        raw: inputStr,
      };
    } catch (error) {
      // Some inputs may not be valid JSON
      return {
        function: null,
        params: null,
        raw: inputStr,
        parseError: error.message,
      };
    }
  }

  /**
   * Determine SmartWeave transaction type from function name
   *
   * @param {string} functionName - SmartWeave function name from Input tag
   * @returns {string} TransactionType value
   */
  static getSmartWeaveType(functionName) {
    if (!functionName) {
      return TransactionType.SMARTWEAVE_INTERACTION;
    }

    const lowerFunc = functionName.toLowerCase();

    // Check for exact matches in the function map
    for (const [func, txType] of Object.entries(SMARTWEAVE_FUNCTION_MAP)) {
      if (lowerFunc === func.toLowerCase()) {
        return txType;
      }
    }

    // Default to generic interaction
    return TransactionType.SMARTWEAVE_INTERACTION;
  }

  /**
   * Create from GQL node response
   *
   * This method normalizes raw GQL transaction data into an ARTransaction object.
   * It handles classification of various transaction types including:
   * - Basic AR transfers (send/receive)
   * - Data uploads
   * - SmartWeave contract interactions (with function-level classification)
   * - Mining and gateway rewards
   *
   * @param {Object} node - GQL transaction node from Arweave GraphQL API
   * @param {Object} options - Additional options for classification
   * @param {string} options.perspective - 'sender' or 'recipient' for classification context
   * @param {boolean} options.isInternalTransfer - Whether this is between owned wallets
   * @param {boolean} options.includeRaw - Include raw transaction data
   * @returns {ARTransaction} Normalized transaction object
   */
  static fromGQLNode(node, options = {}) {
    // Extract tags into a lookup object for efficient access
    const tags = {};
    if (node.tags) {
      node.tags.forEach((tag) => {
        tags[tag.name] = tag.value;
      });
    }

    // Initialize classification variables
    let type = TransactionType.UNKNOWN;
    let appName = null;
    let contractId = null;
    let input = null;
    let inputParsed = null;
    let swFunction = null;
    let swFunctionParams = null;

    // Extract basic transaction metrics for classification logic
    const quantityWinston = node.quantity?.winston || "0";
    const hasQuantity = Number(quantityWinston) > 0;
    const hasData = (node.data?.size || 0) > 0;
    const hasRecipient = !!(node.recipient || node.target);

    // Classification logic - ordered by specificity (most specific first)

    // 1. Check for mining/gateway rewards (special owner address patterns)
    // Mining rewards have an empty or null owner address
    if (
      node.owner?.address === "" ||
      node.owner?.address === "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    ) {
      type = TransactionType.MINING_REWARD;
    }
    // 2. Check for SmartWeave contract interaction
    // SmartWeave transactions are identified by App-Name tag
    else if (
      tags["App-Name"] === "SmartWeaveAction" ||
      tags["App-Name"] === "SmartWeaveContract"
    ) {
      appName = "SmartWeave";
      contractId = tags["Contract"];
      input = tags["Input"];

      // Parse the Input tag to extract function name and parameters
      inputParsed = ARTransaction.parseSmartWeaveInput(input);
      if (inputParsed) {
        swFunction = inputParsed.function;
        swFunctionParams = inputParsed.params;

        // Classify based on function name for more specific tax treatment
        type = ARTransaction.getSmartWeaveType(swFunction);
      } else {
        type = TransactionType.SMARTWEAVE_INTERACTION;
      }
    }
    // 3. Check for AR transfer (has quantity and recipient)
    else if (hasQuantity && hasRecipient) {
      // Classify based on perspective (who is viewing the transaction)
      type =
        options.perspective === "recipient"
          ? TransactionType.RECEIVE
          : TransactionType.SEND;
    }
    // 4. Check for data upload (has data content, minimal/no AR quantity)
    else if (hasData) {
      type = TransactionType.DATA_UPLOAD;
    }
    // 5. Handle zero-AR transfers (still valid transactions for tracking)
    else if (hasRecipient && options.perspective === "sender") {
      type = TransactionType.SEND;
    }
    // 6. Incoming transaction without quantity (may be contract result)
    else if (options.perspective === "recipient") {
      type = TransactionType.RECEIVE;
    }

    // Extract bundle info (ANS-104 bundled data items)
    // Bundled transactions have "Bundle-Version" or are nested in a bundle
    const bundledIn = tags["Bundled-In"] || tags["Bundle-Parent"] || null;
    const isBundled = !!(bundledIn || tags["Bundle-Version"]);
    const bundlerAddress = tags["Bundler-Address"] || null;

    // Construct and return the normalized ARTransaction object
    return new ARTransaction({
      txId: node.id,
      blockHeight: node.block?.height,
      blockTimestamp: node.block?.timestamp,
      ownerAddress: node.owner?.address,
      targetAddress: node.recipient || node.target,
      type: type,
      isInternalTransfer: options.isInternalTransfer || false,
      quantityWinston: node.quantity?.winston || "0",
      rewardWinston: node.fee?.winston || "0",
      dataSize: node.data?.size || 0,
      contentType: tags["Content-Type"] || null,
      appName: appName || tags["App-Name"] || null,
      contractId: contractId,
      input: input,
      inputParsed: inputParsed,
      swFunction: swFunction,
      swFunctionParams: swFunctionParams,
      bundledIn: bundledIn,
      isBundled: isBundled,
      bundlerAddress: bundlerAddress,
      tags: node.tags || [],
      rawTransaction: options.includeRaw ? node : null,
    });
  }
}

module.exports = {
  ARTransaction,
  TransactionType,
  FeeType,
  SMARTWEAVE_FUNCTION_MAP,
};
