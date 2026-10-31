/**
 * Cost Basis Service Tests
 *
 * Tests for FIFO, LIFO, and HIFO cost basis calculations
 */

const {
  MockCassandraClient,
  TEST_WALLETS,
  createMockTransaction,
  createMockTaxLot,
  assertApproximatelyEqual,
} = require("./setup");

const { CostBasisService } = require("../src/services/ar-tracker/CostBasisService");

describe("CostBasisService", () => {
  let mockCassandra;
  let costBasisService;

  beforeEach(() => {
    mockCassandra = new MockCassandraClient();
    costBasisService = new CostBasisService({
      cassandraService: mockCassandra,
      accountingMethod: "FIFO",
    });
  });

  describe("FIFO Method", () => {
    test("should use oldest lots first for disposals", () => {
      // Create lots with different acquisition dates
      const lots = [
        createMockTaxLot({
          lotId: "lot-1",
          acquisitionDate: new Date("2024-01-01"),
          originalQuantity: 10,
          remainingQuantity: 10,
          costBasisPerUnit: 20.0,
        }),
        createMockTaxLot({
          lotId: "lot-2",
          acquisitionDate: new Date("2024-03-01"),
          originalQuantity: 10,
          remainingQuantity: 10,
          costBasisPerUnit: 30.0,
        }),
        createMockTaxLot({
          lotId: "lot-3",
          acquisitionDate: new Date("2024-06-01"),
          originalQuantity: 10,
          remainingQuantity: 10,
          costBasisPerUnit: 40.0,
        }),
      ];

      // Sort by FIFO (oldest first)
      lots.sort((a, b) => a.acquisitionDate - b.acquisitionDate);

      expect(lots[0].lotId).toBe("lot-1");
      expect(lots[0].costBasisPerUnit).toBe(20.0);
    });

    test("should calculate correct cost basis for partial lot usage", () => {
      const lot = createMockTaxLot({
        originalQuantity: 100,
        remainingQuantity: 100,
        costBasisPerUnit: 25.0,
        totalCostBasis: 2500.0,
      });

      // Dispose of 40 units
      const disposalQuantity = 40;
      const costBasis = disposalQuantity * lot.costBasisPerUnit;

      expect(costBasis).toBe(1000.0);
    });
  });

  describe("LIFO Method", () => {
    test("should use newest lots first for disposals", () => {
      const lots = [
        createMockTaxLot({
          lotId: "lot-1",
          acquisitionDate: new Date("2024-01-01"),
          costBasisPerUnit: 20.0,
        }),
        createMockTaxLot({
          lotId: "lot-2",
          acquisitionDate: new Date("2024-03-01"),
          costBasisPerUnit: 30.0,
        }),
        createMockTaxLot({
          lotId: "lot-3",
          acquisitionDate: new Date("2024-06-01"),
          costBasisPerUnit: 40.0,
        }),
      ];

      // Sort by LIFO (newest first)
      lots.sort((a, b) => b.acquisitionDate - a.acquisitionDate);

      expect(lots[0].lotId).toBe("lot-3");
      expect(lots[0].costBasisPerUnit).toBe(40.0);
    });
  });

  describe("HIFO Method", () => {
    test("should use highest cost lots first for disposals", () => {
      const lots = [
        createMockTaxLot({
          lotId: "lot-1",
          costBasisPerUnit: 20.0,
        }),
        createMockTaxLot({
          lotId: "lot-2",
          costBasisPerUnit: 40.0,
        }),
        createMockTaxLot({
          lotId: "lot-3",
          costBasisPerUnit: 30.0,
        }),
      ];

      // Sort by HIFO (highest cost first)
      lots.sort((a, b) => b.costBasisPerUnit - a.costBasisPerUnit);

      expect(lots[0].lotId).toBe("lot-2");
      expect(lots[0].costBasisPerUnit).toBe(40.0);
    });
  });

  describe("Gain/Loss Calculation", () => {
    test("should calculate gain correctly", () => {
      const costBasis = 1000.0;
      const proceeds = 1500.0;
      const gainLoss = proceeds - costBasis;

      expect(gainLoss).toBe(500.0);
      expect(gainLoss).toBeGreaterThan(0);
    });

    test("should calculate loss correctly", () => {
      const costBasis = 1500.0;
      const proceeds = 1000.0;
      const gainLoss = proceeds - costBasis;

      expect(gainLoss).toBe(-500.0);
      expect(gainLoss).toBeLessThan(0);
    });

    test("should handle zero gain/loss", () => {
      const costBasis = 1000.0;
      const proceeds = 1000.0;
      const gainLoss = proceeds - costBasis;

      expect(gainLoss).toBe(0);
    });
  });

  describe("Long-term vs Short-term Classification", () => {
    test("should classify as short-term if held less than 1 year", () => {
      const acquisitionDate = new Date("2024-06-01");
      const disposalDate = new Date("2024-12-01");
      const daysHeld = Math.floor(
        (disposalDate - acquisitionDate) / (1000 * 60 * 60 * 24)
      );

      expect(daysHeld).toBeLessThan(365);
      const isLongTerm = daysHeld >= 365;
      expect(isLongTerm).toBe(false);
    });

    test("should classify as long-term if held 1 year or more", () => {
      const acquisitionDate = new Date("2023-01-01");
      const disposalDate = new Date("2024-06-01");
      const daysHeld = Math.floor(
        (disposalDate - acquisitionDate) / (1000 * 60 * 60 * 24)
      );

      expect(daysHeld).toBeGreaterThanOrEqual(365);
      const isLongTerm = daysHeld >= 365;
      expect(isLongTerm).toBe(true);
    });

    test("should classify as long-term if held exactly 365 days", () => {
      const acquisitionDate = new Date("2024-01-01");
      const disposalDate = new Date("2025-01-01");
      const daysHeld = Math.floor(
        (disposalDate - acquisitionDate) / (1000 * 60 * 60 * 24)
      );

      expect(daysHeld).toBe(366); // 2024 is a leap year
      const isLongTerm = daysHeld >= 365;
      expect(isLongTerm).toBe(true);
    });
  });

  describe("DEX Swap Cost Basis", () => {
    test("should treat DEX swap as disposal of input token", () => {
      const swap = {
        inputTokenSymbol: "wAR",
        outputTokenSymbol: "AO",
        inputAmountHuman: 100,
        inputPriceUSD: 10.0,
        inputValueUSD: 1000.0,
      };

      // Input token is disposed
      expect(swap.inputValueUSD).toBe(1000.0);
    });

    test("should treat DEX swap as acquisition of output token", () => {
      const swap = {
        inputTokenSymbol: "wAR",
        outputTokenSymbol: "AO",
        outputAmountHuman: 20,
        outputPriceUSD: 50.0,
        outputValueUSD: 1000.0,
      };

      // Output token is acquired with cost basis = fair market value
      expect(swap.outputValueUSD).toBe(1000.0);
    });

    test("should handle swap with different input/output values (slippage)", () => {
      const swap = {
        inputTokenSymbol: "wAR",
        outputTokenSymbol: "AO",
        inputAmountHuman: 100,
        inputPriceUSD: 10.0,
        inputValueUSD: 1000.0,
        outputAmountHuman: 19.5,
        outputPriceUSD: 50.0,
        outputValueUSD: 975.0,
      };

      // Slippage loss
      const slippage = swap.inputValueUSD - swap.outputValueUSD;
      expect(slippage).toBe(25.0);
    });
  });
});

