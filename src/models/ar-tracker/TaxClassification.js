/**
 * TaxClassification Model
 *
 * Standardized taxonomy of transaction types and their tax implications.
 * Users can override automatic classifications when our system
 * incorrectly categorizes a transaction or lacks context.
 *
 * Based on IRS guidance for cryptocurrency taxation.
 * Reference: IRS Notice 2014-21, Rev. Rul. 2019-24
 */

/**
 * Tax Event Categories
 *
 * ACQUISITION - Adds to holdings, establishes cost basis
 * DISPOSAL - Removes from holdings, triggers gain/loss calculation
 * INCOME - Taxable as ordinary income at FMV
 * EXPENSE - Deductible or adds to cost basis
 * NON_TAXABLE - No tax impact (but may need to be tracked)
 */
const TaxEventCategory = {
  ACQUISITION: "ACQUISITION",
  DISPOSAL: "DISPOSAL",
  INCOME: "INCOME",
  EXPENSE: "EXPENSE",
  NON_TAXABLE: "NON_TAXABLE",
};

/**
 * Complete Transaction Type Taxonomy
 *
 * Each type includes:
 * - id: Unique identifier
 * - name: Human-readable name
 * - category: Tax event category
 * - description: Explanation for users
 * - taxTreatment: How it's treated for tax purposes
 * - affectsCostBasis: Whether it impacts cost basis tracking
 * - requiresValue: Whether USD value is required
 * - irsForm: Relevant IRS form(s)
 * - userEditable: Can user change to/from this type
 * - autoDetectable: Can be automatically detected by our system
 */
const TransactionTypes = {
  // ============================================================
  // ACQUISITION TYPES (establishes cost basis)
  // ============================================================

  PURCHASE: {
    id: "PURCHASE",
    name: "Purchase",
    category: TaxEventCategory.ACQUISITION,
    description: "Bought crypto with fiat currency (USD, etc.)",
    taxTreatment: "Establishes cost basis at purchase price plus fees",
    affectsCostBasis: true,
    requiresValue: true,
    irsForm: "N/A (acquisition only)",
    userEditable: true,
    autoDetectable: false, // Can't detect fiat side
  },

  TRADE_ACQUISITION: {
    id: "TRADE_ACQUISITION",
    name: "Trade (Received Side)",
    category: TaxEventCategory.ACQUISITION,
    description:
      "Received crypto in exchange for another crypto. " +
      "NOTE: Every trade has TWO events - this is the 'buy' side. " +
      "The crypto you gave up is a separate TRADE_DISPOSAL (taxable).",
    taxTreatment:
      "Establishes cost basis for received crypto at FMV. " +
      "The disposal side triggers capital gain/loss and must be reported.",
    affectsCostBasis: true,
    requiresValue: true,
    irsForm:
      "N/A (this side only establishes basis; TRADE_DISPOSAL reported on Form 8949)",
    userEditable: true,
    autoDetectable: true, // DEX swaps
    linkedEventType: "TRADE_DISPOSAL", // Always paired with a disposal
  },

  AIRDROP: {
    id: "AIRDROP",
    name: "Airdrop",
    category: TaxEventCategory.INCOME,
    description: "Free tokens received via airdrop distribution",
    taxTreatment: "Ordinary income at FMV when received. Cost basis = FMV.",
    affectsCostBasis: true,
    requiresValue: true,
    irsForm: "Schedule 1 (Other Income) or Schedule C if business",
    userEditable: true,
    autoDetectable: true, // Can detect via distribution patterns
  },

  MINING_REWARD: {
    id: "MINING_REWARD",
    name: "Mining Reward",
    category: TaxEventCategory.INCOME,
    description: "Crypto earned from mining activities",
    taxTreatment: "Ordinary income at FMV when received. Cost basis = FMV.",
    affectsCostBasis: true,
    requiresValue: true,
    irsForm: "Schedule C (if business) or Schedule 1",
    userEditable: true,
    autoDetectable: true, // No sender address
  },

  STAKING_REWARD: {
    id: "STAKING_REWARD",
    name: "Staking Reward",
    category: TaxEventCategory.INCOME,
    description: "Crypto earned from staking/validation",
    taxTreatment: "Ordinary income at FMV when received. Cost basis = FMV.",
    affectsCostBasis: true,
    requiresValue: true,
    irsForm: "Schedule 1 or Schedule C",
    userEditable: true,
    autoDetectable: true, // From staking contracts
  },

  GATEWAY_REWARD: {
    id: "GATEWAY_REWARD",
    name: "Gateway Operator Reward",
    category: TaxEventCategory.INCOME,
    description: "AR earned from running an Arweave gateway",
    taxTreatment: "Ordinary income at FMV when received. Cost basis = FMV.",
    affectsCostBasis: true,
    requiresValue: true,
    irsForm: "Schedule C (business income)",
    userEditable: true,
    autoDetectable: true, // From gateway contracts
  },

  GIFT_RECEIVED: {
    id: "GIFT_RECEIVED",
    name: "Gift Received",
    category: TaxEventCategory.ACQUISITION,
    description: "Crypto received as a gift from another person",
    taxTreatment:
      "No income on receipt. Cost basis = donor's cost basis (carryover basis)",
    affectsCostBasis: true,
    requiresValue: false, // Uses donor's basis
    irsForm: "N/A (Form 709 for donor if >$17k)",
    userEditable: true,
    autoDetectable: false, // Looks like regular transfer
    notes: "Recipient inherits donor's cost basis and holding period",
  },

  INHERITANCE: {
    id: "INHERITANCE",
    name: "Inheritance",
    category: TaxEventCategory.ACQUISITION,
    description: "Crypto inherited from a deceased person",
    taxTreatment: "Cost basis = FMV at date of death (stepped-up basis)",
    affectsCostBasis: true,
    requiresValue: true,
    irsForm: "Estate Form 706 (if applicable)",
    userEditable: true,
    autoDetectable: false,
    notes: "Stepped-up basis eliminates unrealized gains",
  },

  HARD_FORK: {
    id: "HARD_FORK",
    name: "Hard Fork",
    category: TaxEventCategory.INCOME,
    description: "New tokens received from blockchain hard fork",
    taxTreatment: "Ordinary income at FMV when received. Cost basis = FMV.",
    affectsCostBasis: true,
    requiresValue: true,
    irsForm: "Schedule 1 (Other Income)",
    userEditable: true,
    autoDetectable: false,
  },

  INTEREST_INCOME: {
    id: "INTEREST_INCOME",
    name: "Interest/Yield",
    category: TaxEventCategory.INCOME,
    description: "Crypto earned as interest from lending or DeFi",
    taxTreatment: "Ordinary income at FMV when received. Cost basis = FMV.",
    affectsCostBasis: true,
    requiresValue: true,
    irsForm: "Schedule B (Interest Income)",
    userEditable: true,
    autoDetectable: true, // From lending protocols
  },

  REBATE_OR_CASHBACK: {
    id: "REBATE_OR_CASHBACK",
    name: "Rebate/Cashback",
    category: TaxEventCategory.ACQUISITION,
    description: "Crypto received as purchase rebate or cashback",
    taxTreatment: "Generally not taxable income. Cost basis = $0 or FMV.",
    affectsCostBasis: true,
    requiresValue: false,
    irsForm: "Typically N/A",
    userEditable: true,
    autoDetectable: false,
    notes: "Treatment depends on context - consult tax advisor",
  },

  // ============================================================
  // DISPOSAL TYPES (triggers gain/loss calculation)
  // ============================================================

  SALE: {
    id: "SALE",
    name: "Sale",
    category: TaxEventCategory.DISPOSAL,
    description: "Sold crypto for fiat currency (USD, etc.)",
    taxTreatment: "Capital gain/loss = Proceeds - Cost Basis",
    affectsCostBasis: true,
    requiresValue: true,
    irsForm: "Form 8949, Schedule D",
    userEditable: true,
    autoDetectable: false, // Can't detect fiat side
  },

  TRADE_DISPOSAL: {
    id: "TRADE_DISPOSAL",
    name: "Trade (Sent Side)",
    category: TaxEventCategory.DISPOSAL,
    description:
      "Sent crypto in exchange for another crypto. " +
      "NOTE: Every trade has TWO events - this is the 'sell' side that triggers tax. " +
      "The crypto you received is a separate TRADE_ACQUISITION.",
    taxTreatment:
      "TAXABLE: Capital gain/loss = FMV of crypto received - Cost basis of crypto sent. " +
      "IRS treats crypto-to-crypto trades as a sale followed by a purchase.",
    affectsCostBasis: true,
    requiresValue: true,
    irsForm: "Form 8949, Schedule D",
    userEditable: true,
    autoDetectable: true, // DEX swaps
    linkedEventType: "TRADE_ACQUISITION", // Always paired with an acquisition
  },

  GIFT_SENT: {
    id: "GIFT_SENT",
    name: "Gift Sent",
    category: TaxEventCategory.DISPOSAL,
    description: "Gave crypto as a gift to another person",
    taxTreatment: "No gain/loss for donor. May require Form 709 if >$17k.",
    affectsCostBasis: true,
    requiresValue: true,
    irsForm: "Form 709 (Gift Tax Return) if over annual exclusion",
    userEditable: true,
    autoDetectable: false, // Looks like regular transfer
    notes: "2024 annual gift exclusion: $18,000 per recipient",
  },

  DONATION: {
    id: "DONATION",
    name: "Charitable Donation",
    category: TaxEventCategory.DISPOSAL,
    description: "Donated crypto to a qualified charity",
    taxTreatment:
      "No capital gains. Deduction = FMV if held >1yr, or cost basis if <1yr.",
    affectsCostBasis: true,
    requiresValue: true,
    irsForm: "Schedule A (Itemized Deductions)",
    userEditable: true,
    autoDetectable: false,
    notes: "Requires charity acknowledgment. Form 8283 if >$500.",
  },

  PAYMENT_FOR_GOODS: {
    id: "PAYMENT_FOR_GOODS",
    name: "Payment for Goods",
    category: TaxEventCategory.DISPOSAL,
    description: "Used crypto to purchase goods or services",
    taxTreatment: "Capital gain/loss = FMV of goods - Cost Basis",
    affectsCostBasis: true,
    requiresValue: true,
    irsForm: "Form 8949, Schedule D",
    userEditable: true,
    autoDetectable: false,
  },

  PAYMENT_FOR_SERVICES: {
    id: "PAYMENT_FOR_SERVICES",
    name: "Payment for Services",
    category: TaxEventCategory.DISPOSAL,
    description: "Used crypto to pay for services",
    taxTreatment: "Capital gain/loss = FMV of services - Cost Basis",
    affectsCostBasis: true,
    requiresValue: true,
    irsForm: "Form 8949, Schedule D",
    userEditable: true,
    autoDetectable: false,
  },

  LOST_OR_STOLEN: {
    id: "LOST_OR_STOLEN",
    name: "Lost or Stolen",
    category: TaxEventCategory.DISPOSAL,
    description: "Crypto lost due to theft, hack, or lost keys",
    taxTreatment:
      "Capital loss may be claimable. Casualty loss rules apply (limited after TCJA).",
    affectsCostBasis: true,
    requiresValue: true,
    irsForm: "Form 4684 (Casualties and Thefts)",
    userEditable: true,
    autoDetectable: false,
    notes: "Personal casualty losses limited since 2018 tax reform",
  },

  MARGIN_FEE: {
    id: "MARGIN_FEE",
    name: "Margin Interest/Fee",
    category: TaxEventCategory.DISPOSAL,
    description: "Crypto used to pay margin trading fees or liquidation",
    taxTreatment:
      "Capital gain/loss on crypto used. Interest may be deductible.",
    affectsCostBasis: true,
    requiresValue: true,
    irsForm: "Form 8949, Schedule D",
    userEditable: true,
    autoDetectable: false,
  },

  // ============================================================
  // NON-TAXABLE EVENTS (tracking only)
  // ============================================================

  INTERNAL_TRANSFER: {
    id: "INTERNAL_TRANSFER",
    name: "Transfer Between Own Wallets",
    category: TaxEventCategory.NON_TAXABLE,
    description: "Moved crypto between your own wallets",
    taxTreatment: "No tax event. Fees may be added to cost basis.",
    affectsCostBasis: false,
    requiresValue: false,
    irsForm: "N/A",
    userEditable: true,
    autoDetectable: true, // If wallets in same identity
    notes: "Transaction fees can be added to cost basis of holdings",
  },

  DEPOSIT_TO_EXCHANGE: {
    id: "DEPOSIT_TO_EXCHANGE",
    name: "Deposit to Exchange",
    category: TaxEventCategory.NON_TAXABLE,
    description: "Deposited crypto to a centralized exchange",
    taxTreatment: "No tax event. Custody change only.",
    affectsCostBasis: false,
    requiresValue: false,
    irsForm: "N/A",
    userEditable: true,
    autoDetectable: false,
  },

  WITHDRAWAL_FROM_EXCHANGE: {
    id: "WITHDRAWAL_FROM_EXCHANGE",
    name: "Withdrawal from Exchange",
    category: TaxEventCategory.NON_TAXABLE,
    description: "Withdrew crypto from a centralized exchange",
    taxTreatment: "No tax event. Custody change only.",
    affectsCostBasis: false,
    requiresValue: false,
    irsForm: "N/A",
    userEditable: true,
    autoDetectable: false,
  },

  WRAP_UNWRAP: {
    id: "WRAP_UNWRAP",
    name: "Wrap/Unwrap Token",
    category: TaxEventCategory.NON_TAXABLE,
    description: "Wrapped or unwrapped a token (e.g., AR ↔ wAR)",
    taxTreatment: "Generally non-taxable if 1:1 wrap. Some argue it's a trade.",
    affectsCostBasis: false,
    requiresValue: false,
    irsForm: "N/A (unless treated as trade)",
    userEditable: true,
    autoDetectable: true, // Bridge transactions
    notes: "Tax treatment of wrapping is not fully settled. Consult advisor.",
  },

  BRIDGE_TRANSFER: {
    id: "BRIDGE_TRANSFER",
    name: "Cross-Chain Bridge",
    category: TaxEventCategory.NON_TAXABLE,
    description: "Moved tokens across blockchains via bridge",
    taxTreatment:
      "Generally non-taxable if same token. May be taxable if different.",
    affectsCostBasis: false,
    requiresValue: false,
    irsForm: "N/A (unless token changes)",
    userEditable: true,
    autoDetectable: true, // Bridge contracts
    notes: "If you receive a different token, it may be a taxable trade.",
  },

  FAILED_TRANSACTION: {
    id: "FAILED_TRANSACTION",
    name: "Failed/Reverted Transaction",
    category: TaxEventCategory.NON_TAXABLE,
    description: "Transaction that failed or was reverted",
    taxTreatment: "No tax event. Gas fees may still be deductible.",
    affectsCostBasis: false,
    requiresValue: false,
    irsForm: "N/A",
    userEditable: true,
    autoDetectable: true,
  },

  // ============================================================
  // EXPENSE/FEE TYPES (deductible or adds to basis)
  // ============================================================

  TRANSACTION_FEE: {
    id: "TRANSACTION_FEE",
    name: "Transaction Fee (Gas)",
    category: TaxEventCategory.EXPENSE,
    description: "Network fee paid to execute a transaction",
    taxTreatment:
      "Adds to cost basis of acquisition OR reduces proceeds of disposal",
    affectsCostBasis: true,
    requiresValue: true,
    irsForm: "Included in Form 8949 calculations",
    userEditable: true,
    autoDetectable: true,
  },

  DATA_UPLOAD_FEE: {
    id: "DATA_UPLOAD_FEE",
    name: "Data Storage Fee",
    category: TaxEventCategory.EXPENSE,
    description: "Fee paid to upload data to Arweave blockweave",
    taxTreatment:
      "Capital loss on AR used. May be business expense if applicable.",
    affectsCostBasis: true,
    requiresValue: true,
    irsForm: "Form 8949 (for AR disposal), Schedule C (if business)",
    userEditable: true,
    autoDetectable: true,
  },

  CONTRACT_INTERACTION_FEE: {
    id: "CONTRACT_INTERACTION_FEE",
    name: "Smart Contract Fee",
    category: TaxEventCategory.EXPENSE,
    description: "Fee paid to interact with a smart contract",
    taxTreatment:
      "Adds to cost basis of resulting acquisition OR is a disposal",
    affectsCostBasis: true,
    requiresValue: true,
    irsForm: "Included in Form 8949 calculations",
    userEditable: true,
    autoDetectable: true,
  },

  // ============================================================
  // SPECIAL CASES
  // ============================================================

  SPAM_AIRDROP: {
    id: "SPAM_AIRDROP",
    name: "Spam/Dust Airdrop",
    category: TaxEventCategory.NON_TAXABLE,
    description: "Unsolicited spam tokens with no real value",
    taxTreatment: "No income if zero FMV. Can ignore for tax purposes.",
    affectsCostBasis: false,
    requiresValue: false,
    irsForm: "N/A",
    userEditable: true,
    autoDetectable: false,
    notes: "Mark worthless airdrops as spam to exclude from reports",
  },

  UNKNOWN: {
    id: "UNKNOWN",
    name: "Unknown/Unclassified",
    category: TaxEventCategory.NON_TAXABLE,
    description: "Transaction type could not be automatically determined",
    taxTreatment: "User must classify to determine tax treatment",
    affectsCostBasis: false,
    requiresValue: false,
    irsForm: "Depends on classification",
    userEditable: true,
    autoDetectable: false,
    notes: "MUST be classified by user before generating tax reports",
  },
};

/**
 * Get all transaction types grouped by category
 * @returns {Object}
 */
function getTypesByCategory() {
  const grouped = {};

  for (const [key, type] of Object.entries(TransactionTypes)) {
    const category = type.category;
    if (!grouped[category]) {
      grouped[category] = [];
    }
    grouped[category].push(type);
  }

  return grouped;
}

/**
 * Get types that can be automatically detected
 * @returns {Object[]}
 */
function getAutoDetectableTypes() {
  return Object.values(TransactionTypes).filter((t) => t.autoDetectable);
}

/**
 * Get types by tax category
 * @param {string} category - TaxEventCategory value
 * @returns {Object[]}
 */
function getTypesByTaxCategory(category) {
  return Object.values(TransactionTypes).filter((t) => t.category === category);
}

/**
 * Check if a type is a taxable event
 * @param {string} typeId
 * @returns {boolean}
 */
function isTaxableEvent(typeId) {
  const type = TransactionTypes[typeId];
  if (!type) return false;

  return [TaxEventCategory.DISPOSAL, TaxEventCategory.INCOME].includes(
    type.category
  );
}

/**
 * Check if type triggers capital gains calculation
 * @param {string} typeId
 * @returns {boolean}
 */
function triggersCapitalGains(typeId) {
  const type = TransactionTypes[typeId];
  if (!type) return false;

  return type.category === TaxEventCategory.DISPOSAL;
}

/**
 * Check if type is treated as income
 * @param {string} typeId
 * @returns {boolean}
 */
function isTreatedAsIncome(typeId) {
  const type = TransactionTypes[typeId];
  if (!type) return false;

  return type.category === TaxEventCategory.INCOME;
}

/**
 * Get all valid transition types for user reclassification
 * Some transitions don't make sense (e.g., mining → sale)
 * @param {string} fromTypeId
 * @returns {string[]}
 */
function getValidReclassifications(fromTypeId) {
  const fromType = TransactionTypes[fromTypeId];
  if (!fromType) return Object.keys(TransactionTypes);

  // Define logical reclassification rules
  const rules = {
    // Outgoing transactions (sent crypto)
    outgoing: [
      "SALE",
      "TRADE_DISPOSAL",
      "GIFT_SENT",
      "DONATION",
      "PAYMENT_FOR_GOODS",
      "PAYMENT_FOR_SERVICES",
      "INTERNAL_TRANSFER",
      "DEPOSIT_TO_EXCHANGE",
      "LOST_OR_STOLEN",
      "MARGIN_FEE",
      "DATA_UPLOAD_FEE",
      "CONTRACT_INTERACTION_FEE",
    ],
    // Incoming transactions (received crypto)
    incoming: [
      "PURCHASE",
      "TRADE_ACQUISITION",
      "AIRDROP",
      "MINING_REWARD",
      "STAKING_REWARD",
      "GATEWAY_REWARD",
      "GIFT_RECEIVED",
      "INHERITANCE",
      "HARD_FORK",
      "INTEREST_INCOME",
      "REBATE_OR_CASHBACK",
      "INTERNAL_TRANSFER",
      "WITHDRAWAL_FROM_EXCHANGE",
      "SPAM_AIRDROP",
    ],
  };

  // Determine direction based on current type
  if (
    [
      "SALE",
      "TRADE_DISPOSAL",
      "GIFT_SENT",
      "DONATION",
      "PAYMENT_FOR_GOODS",
      "PAYMENT_FOR_SERVICES",
      "LOST_OR_STOLEN",
      "MARGIN_FEE",
      "INTERNAL_TRANSFER",
      "DEPOSIT_TO_EXCHANGE",
      "DATA_UPLOAD_FEE",
      "CONTRACT_INTERACTION_FEE",
      "TRANSACTION_FEE",
    ].includes(fromTypeId)
  ) {
    return rules.outgoing;
  }

  if (
    [
      "PURCHASE",
      "TRADE_ACQUISITION",
      "AIRDROP",
      "MINING_REWARD",
      "STAKING_REWARD",
      "GATEWAY_REWARD",
      "GIFT_RECEIVED",
      "INHERITANCE",
      "HARD_FORK",
      "INTEREST_INCOME",
      "REBATE_OR_CASHBACK",
      "WITHDRAWAL_FROM_EXCHANGE",
      "SPAM_AIRDROP",
    ].includes(fromTypeId)
  ) {
    return rules.incoming;
  }

  // Unknown or edge cases - allow all
  return Object.keys(TransactionTypes);
}

/**
 * Transaction classification override record
 */
class ClassificationOverride {
  constructor(config) {
    this.txId = config.txId;
    this.originalType = config.originalType;
    this.newType = config.newType;
    this.reason = config.reason || null;
    this.overriddenBy = config.overriddenBy || "user";
    this.overriddenAt = new Date();

    // Validate the new type exists
    if (!TransactionTypes[config.newType]) {
      throw new Error(`Invalid transaction type: ${config.newType}`);
    }
  }

  toJSON() {
    return {
      txId: this.txId,
      originalType: this.originalType,
      newType: this.newType,
      reason: this.reason,
      overriddenBy: this.overriddenBy,
      overriddenAt: this.overriddenAt.toISOString(),
    };
  }
}

module.exports = {
  TaxEventCategory,
  TransactionTypes,
  getTypesByCategory,
  getAutoDetectableTypes,
  getTypesByTaxCategory,
  isTaxableEvent,
  triggersCapitalGains,
  isTreatedAsIncome,
  getValidReclassifications,
  ClassificationOverride,
};
