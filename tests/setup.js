/**
 * Test Setup and Utilities for AO Tax Tracker Server
 *
 * Provides test utilities, mocks, and setup for all tests
 */

// Increase timeout for database operations
jest.setTimeout(30000);

// Mock Cassandra client for unit tests
class MockCassandraClient {
  constructor() {
    this.data = new Map();
    this.queries = [];
    this.isConnected = true;
    this.client = {
      execute: jest.fn().mockResolvedValue({ rows: [] }),
      batch: jest.fn().mockResolvedValue(undefined),
      connect: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
    };
  }

  async connect() {
    this.isConnected = true;
    return Promise.resolve();
  }

  async disconnect() {
    this.isConnected = false;
    return Promise.resolve();
  }

  async useKeyspace() {
    return Promise.resolve();
  }

  async execute(query, params, options = {}) {
    this.queries.push({ query, params, options });
    return { rows: [] };
  }

  async batch(queries, options) {
    this.queries.push(...queries);
    return Promise.resolve();
  }

  async saveUnifiedTransactionsBatch(transactions) {
    if (!transactions || transactions.length === 0) return 0;
    return transactions.length;
  }

  async getUnifiedTransactions(walletAddress, startDate, endDate) {
    return [];
  }

  async initializeSchema() {
    return Promise.resolve();
  }

  async getReportSummaryCache(wallet, taxYear) {
    return null;
  }

  async saveReportSummaryCache(summary) {
    return Promise.resolve();
  }
}

// Test wallet addresses
const TEST_WALLETS = [
  "cF0H0SKdnaDTqWKY9iJKBktTpdEWgb3GnlndE7ABv0Q",
  "pZkvXGaicIvbxLRM7PiiO3AV-F3dQbas-Vp7sH71xOE",
  "GtDQcrr2QRdoZ-lKto_S_SpzEwiZiHVaj3x4jAgRh4o",
  "uzESID1JQp8m4RO7YjfVZ8eWtRsSrxLp1SilTj7psB8",
];

const EXTERNAL_WALLET = "ExternalWalletNotOwnedByUser1234567890abc";

// Token process IDs for testing
const TEST_TOKENS = {
  AO: "AgYfToP9RhAqLhvL8YWz_W4Z_JyPx6F3OaZI8K2kBDc",
  ARIO: "HTV-FdERHTdLG6Bt1Yr7uiQFfXXFhflXzXCzWvFW5bc",
  wAR: "xU9zFkq3X2ZQ6olwNVvr1vUWIjc3kXTWr7xKQD6dh10",
};

// Create mock transaction data
function createMockTransaction(overrides = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    txId: `test-tx-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    walletAddress: TEST_WALLETS[0],
    blockTimestamp: timestamp,
    blockHeight: 1500000,
    type: "RECEIVE",
    tokenSymbol: "AR",
    tokenProcessId: null,
    amountHuman: 1.0,
    amountUnits: "1000000000000",
    priceUSD: 10.0,
    valueUSD: 10.0,
    source: "ar_l1",
    taxCategory: "ACQUISITION",
    isTaxableEvent: true,
    isInternalTransfer: false,
    ...overrides,
  };
}

function createMockDEXSwap(overrides = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    txId: `test-swap-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    walletAddress: TEST_WALLETS[0],
    blockTimestamp: timestamp,
    blockHeight: 1500000,
    type: "DEX_SWAP",
    inputTokenSymbol: "wAR",
    outputTokenSymbol: "AO",
    inputAmountHuman: 100.0,
    outputAmountHuman: 20.0,
    inputPriceUSD: 9.0,
    outputPriceUSD: 45.0,
    inputValueUSD: 900.0,
    outputValueUSD: 900.0,
    source: "permaswap",
    isSwap: true,
    isTaxableEvent: true,
    isInternalTransfer: false,
    taxCategory: "DISPOSAL",
    ...overrides,
  };
}

function createMockDistribution(overrides = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    txId: `test-dist-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    walletAddress: TEST_WALLETS[0],
    blockTimestamp: timestamp,
    blockHeight: 1500000,
    type: "DISTRIBUTION",
    tokenSymbol: "ARIO",
    tokenProcessId: TEST_TOKENS.ARIO,
    amountHuman: 1000.0,
    amountUnits: "1000000000000000",
    priceUSD: 0.05,
    valueUSD: 50.0,
    source: "ARIO_CONTRACT",
    taxCategory: "INCOME",
    isTaxableEvent: true,
    isInternalTransfer: false,
    isStaked: false,
    ...overrides,
  };
}

function createMockTaxLot(overrides = {}) {
  return {
    lotId: `lot-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    walletAddress: TEST_WALLETS[0],
    tokenSymbol: "AR",
    acquisitionDate: new Date("2024-01-15"),
    acquisitionTxId: `acq-${Date.now()}`,
    originalQuantity: 100.0,
    remainingQuantity: 100.0,
    costBasisPerUnit: 25.0,
    totalCostBasis: 2500.0,
    status: "OPEN",
    accountingMethod: "FIFO",
    ...overrides,
  };
}

// Utility functions
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDate(date) {
  return date.toISOString().split("T")[0];
}

function daysBetween(date1, date2) {
  const oneDay = 24 * 60 * 60 * 1000;
  return Math.round(Math.abs((date2 - date1) / oneDay));
}

// Assertion helpers
function assertApproximatelyEqual(actual, expected, tolerance = 0.01, message = "") {
  const diff = Math.abs(actual - expected);
  if (diff > tolerance) {
    throw new Error(
      `${message} Expected ${expected} ± ${tolerance}, got ${actual} (diff: ${diff})`
    );
  }
}

module.exports = {
  MockCassandraClient,
  TEST_WALLETS,
  EXTERNAL_WALLET,
  TEST_TOKENS,
  createMockTransaction,
  createMockDEXSwap,
  createMockDistribution,
  createMockTaxLot,
  sleep,
  formatDate,
  daysBetween,
  assertApproximatelyEqual,
};

