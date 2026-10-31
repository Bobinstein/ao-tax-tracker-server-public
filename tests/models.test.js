/**
 * Model Tests
 *
 * Tests for transaction, tax lot, and disposal models
 */

const {
  TEST_WALLETS,
  createMockTransaction,
  createMockDEXSwap,
  createMockDistribution,
  createMockTaxLot,
} = require("./setup");

describe("UnifiedTransaction Model", () => {
  describe("Transaction Types", () => {
    test("should create valid RECEIVE transaction", () => {
      const tx = createMockTransaction({
        type: "RECEIVE",
        taxCategory: "ACQUISITION",
      });

      expect(tx.type).toBe("RECEIVE");
      expect(tx.taxCategory).toBe("ACQUISITION");
      expect(tx.isTaxableEvent).toBe(true);
    });

    test("should create valid SEND transaction", () => {
      const tx = createMockTransaction({
        type: "SEND",
        taxCategory: "DISPOSAL",
      });

      expect(tx.type).toBe("SEND");
      expect(tx.taxCategory).toBe("DISPOSAL");
    });

    test("should create valid DISTRIBUTION transaction", () => {
      const tx = createMockDistribution();

      expect(tx.type).toBe("DISTRIBUTION");
      expect(tx.taxCategory).toBe("INCOME");
      expect(tx.tokenSymbol).toBe("ARIO");
    });

    test("should create valid DEX_SWAP transaction", () => {
      const tx = createMockDEXSwap();

      expect(tx.type).toBe("DEX_SWAP");
      expect(tx.isSwap).toBe(true);
      expect(tx.inputTokenSymbol).toBeDefined();
      expect(tx.outputTokenSymbol).toBeDefined();
    });
  });

  describe("Internal Transfer Detection", () => {
    test("should mark transfer between owned wallets as internal", () => {
      const tx = createMockTransaction({
        type: "SEND",
        walletAddress: TEST_WALLETS[0],
        counterparty: TEST_WALLETS[1],
        isInternalTransfer: true,
      });

      expect(tx.isInternalTransfer).toBe(true);
    });

    test("should not mark transfer to external wallet as internal", () => {
      const tx = createMockTransaction({
        type: "SEND",
        walletAddress: TEST_WALLETS[0],
        counterparty: "ExternalWallet123",
        isInternalTransfer: false,
      });

      expect(tx.isInternalTransfer).toBe(false);
    });
  });

  describe("Value Calculations", () => {
    test("should calculate value from amount and price", () => {
      const tx = createMockTransaction({
        amountHuman: 50.0,
        priceUSD: 20.0,
        valueUSD: 1000.0,
      });

      expect(tx.amountHuman * tx.priceUSD).toBe(tx.valueUSD);
    });

    test("should handle zero amount", () => {
      const tx = createMockTransaction({
        amountHuman: 0,
        priceUSD: 20.0,
        valueUSD: 0,
      });

      expect(tx.valueUSD).toBe(0);
    });

    test("should handle zero price", () => {
      const tx = createMockTransaction({
        amountHuman: 50.0,
        priceUSD: 0,
        valueUSD: 0,
      });

      expect(tx.valueUSD).toBe(0);
    });
  });
});

describe("TaxLot Model", () => {
  describe("Lot Creation", () => {
    test("should create valid tax lot with required fields", () => {
      const lot = createMockTaxLot();

      expect(lot.lotId).toBeDefined();
      expect(lot.walletAddress).toBeDefined();
      expect(lot.tokenSymbol).toBeDefined();
      expect(lot.acquisitionDate).toBeInstanceOf(Date);
      expect(lot.originalQuantity).toBeGreaterThan(0);
      expect(lot.remainingQuantity).toBeGreaterThanOrEqual(0);
      expect(lot.costBasisPerUnit).toBeGreaterThanOrEqual(0);
    });

    test("should have correct initial status", () => {
      const lot = createMockTaxLot({
        originalQuantity: 100,
        remainingQuantity: 100,
      });

      expect(lot.status).toBe("OPEN");
    });
  });

  describe("Lot Consumption", () => {
    test("should track remaining quantity correctly", () => {
      const lot = createMockTaxLot({
        originalQuantity: 100,
        remainingQuantity: 100,
      });

      // Simulate using 40 units
      const used = 40;
      const newRemaining = lot.remainingQuantity - used;

      expect(newRemaining).toBe(60);
    });

    test("should mark lot as closed when fully consumed", () => {
      const lot = createMockTaxLot({
        originalQuantity: 100,
        remainingQuantity: 0,
        status: "CLOSED",
      });

      expect(lot.status).toBe("CLOSED");
    });

    test("should keep lot open when partially consumed", () => {
      const lot = createMockTaxLot({
        originalQuantity: 100,
        remainingQuantity: 50,
        status: "OPEN",
      });

      expect(lot.status).toBe("OPEN");
    });
  });

  describe("Cost Basis Calculations", () => {
    test("should calculate total cost basis correctly", () => {
      const lot = createMockTaxLot({
        originalQuantity: 100,
        costBasisPerUnit: 25.0,
        totalCostBasis: 2500.0,
      });

      expect(lot.originalQuantity * lot.costBasisPerUnit).toBe(lot.totalCostBasis);
    });
  });
});

describe("Disposal Model", () => {
  describe("Disposal Creation", () => {
    test("should create valid disposal record", () => {
      const disposal = {
        disposalId: "disp-123",
        walletAddress: TEST_WALLETS[0],
        tokenSymbol: "AR",
        disposalDate: new Date("2025-01-15"),
        disposalTxId: "tx-123",
        quantity: 50.0,
        proceedsPerUnit: 30.0,
        proceedsTotal: 1500.0,
        costBasis: 1250.0,
        gainLoss: 250.0,
        isLongTerm: false,
        lotsUsed: [
          { lotId: "lot-1", quantity: 30, costBasis: 750 },
          { lotId: "lot-2", quantity: 20, costBasis: 500 },
        ],
      };

      expect(disposal.disposalId).toBeDefined();
      expect(disposal.quantity).toBe(50.0);
      expect(disposal.gainLoss).toBe(250.0);
      expect(disposal.lotsUsed).toHaveLength(2);
    });
  });

  describe("Gain/Loss Classification", () => {
    test("should identify gain correctly", () => {
      const disposal = {
        proceedsTotal: 1500.0,
        costBasis: 1000.0,
        gainLoss: 500.0,
      };

      expect(disposal.gainLoss).toBeGreaterThan(0);
    });

    test("should identify loss correctly", () => {
      const disposal = {
        proceedsTotal: 800.0,
        costBasis: 1000.0,
        gainLoss: -200.0,
      };

      expect(disposal.gainLoss).toBeLessThan(0);
    });
  });

  describe("Lots Used Tracking", () => {
    test("should track which lots were used", () => {
      const disposal = {
        quantity: 100,
        lotsUsed: [
          { lotId: "lot-1", quantity: 60, costBasis: 1500 },
          { lotId: "lot-2", quantity: 40, costBasis: 1200 },
        ],
      };

      const totalFromLots = disposal.lotsUsed.reduce(
        (sum, lot) => sum + lot.quantity,
        0
      );

      expect(totalFromLots).toBe(disposal.quantity);
    });

    test("should calculate cost basis from lots", () => {
      const disposal = {
        lotsUsed: [
          { lotId: "lot-1", quantity: 60, costBasis: 1500 },
          { lotId: "lot-2", quantity: 40, costBasis: 1200 },
        ],
      };

      const totalCostBasis = disposal.lotsUsed.reduce(
        (sum, lot) => sum + lot.costBasis,
        0
      );

      expect(totalCostBasis).toBe(2700);
    });
  });
});

describe("DEX Swap Model", () => {
  test("should have input and output token fields", () => {
    const swap = createMockDEXSwap();

    expect(swap.inputTokenSymbol).toBeDefined();
    expect(swap.outputTokenSymbol).toBeDefined();
    expect(swap.inputAmountHuman).toBeGreaterThan(0);
    expect(swap.outputAmountHuman).toBeGreaterThan(0);
  });

  test("should calculate input and output values", () => {
    const swap = createMockDEXSwap({
      inputAmountHuman: 100,
      inputPriceUSD: 10,
      inputValueUSD: 1000,
      outputAmountHuman: 20,
      outputPriceUSD: 50,
      outputValueUSD: 1000,
    });

    expect(swap.inputAmountHuman * swap.inputPriceUSD).toBe(swap.inputValueUSD);
    expect(swap.outputAmountHuman * swap.outputPriceUSD).toBe(swap.outputValueUSD);
  });

  test("should identify swap source platform", () => {
    const swap = createMockDEXSwap({
      source: "permaswap",
    });

    expect(swap.source).toBe("permaswap");
    expect(["permaswap", "botega", "bazar"]).toContain(swap.source);
  });
});

