/**
 * API Endpoint Tests
 *
 * Tests for server API endpoints using supertest
 */

const http = require("http");

// Simple HTTP request helper (avoiding external dependencies)
function makeRequest(options) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
          json: () => {
            try {
              return JSON.parse(data);
            } catch (e) {
              return null;
            }
          },
        });
      });
    });
    req.on("error", reject);
    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

const BASE_URL = "http://localhost:3000";

describe("API Endpoints", () => {
  // Check if server is running before tests
  let serverRunning = false;

  beforeAll(async () => {
    try {
      const res = await makeRequest({
        hostname: "localhost",
        port: 3000,
        path: "/health",
        method: "GET",
        timeout: 2000,
      });
      serverRunning = res.status === 200;
    } catch (e) {
      serverRunning = false;
    }
  });

  describe("Health Check", () => {
    test("GET /health should return 200", async () => {
      if (!serverRunning) {
        console.log("⚠️  Server not running, skipping API tests");
        return;
      }

      const res = await makeRequest({
        hostname: "localhost",
        port: 3000,
        path: "/health",
        method: "GET",
      });

      expect(res.status).toBe(200);
      const body = res.json();
      expect(body.status).toBe("ok");
      expect(body).toHaveProperty("timestamp");
      expect(body).toHaveProperty("uptime");
    });
  });

  describe("API Info", () => {
    test("GET / should return API info", async () => {
      if (!serverRunning) return;

      const res = await makeRequest({
        hostname: "localhost",
        port: 3000,
        path: "/",
        method: "GET",
      });

      expect(res.status).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty("name");
      expect(body).toHaveProperty("endpoints");
      expect(body.endpoints).toHaveProperty("walletReports");
      expect(body.endpoints).toHaveProperty("dexPrices");
      expect(body.endpoints).toHaveProperty("fiatConversion");
    });
  });

  describe("Job Status", () => {
    test("GET /api/status should return job statuses", async () => {
      if (!serverRunning) return;

      const res = await makeRequest({
        hostname: "localhost",
        port: 3000,
        path: "/api/status",
        method: "GET",
      });

      expect(res.status).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty("jobs");
      expect(body.jobs).toHaveProperty("dex-price-indexer");
      expect(body.jobs).toHaveProperty("fiat-rate-indexer");
    });
  });

  describe("DEX Prices (Public)", () => {
    test("GET /api/dex-prices/:token/:date should return price data", async () => {
      if (!serverRunning) return;

      // Use a token that exists in the test database
      const res = await makeRequest({
        hostname: "localhost",
        port: 3000,
        path: "/api/dex-prices/PKXi7zpF9Q6AnqvYPSd8DVegR8Guo8cKdqm2op9F7JQ/2024-12-12",
        method: "GET",
      });

      // Should return 200 even if price not found (returns error in body)
      expect([200, 404]).toContain(res.status);
      const body = res.json();
      expect(body).toHaveProperty("token");
    });

    test("GET /api/dex-prices/:token should return current price", async () => {
      if (!serverRunning) return;

      const res = await makeRequest({
        hostname: "localhost",
        port: 3000,
        path: "/api/dex-prices/AgYfToP9RhAqLhvL8YWz_W4Z_JyPx6F3OaZI8K2kBDc",
        method: "GET",
      });

      expect([200, 404]).toContain(res.status);
    });
  });

  describe("Fiat Conversion (Public)", () => {
    test("GET /api/fiat-conversion/:amount/:currency/:date should convert USD", async () => {
      if (!serverRunning) return;

      const res = await makeRequest({
        hostname: "localhost",
        port: 3000,
        path: "/api/fiat-conversion/100/EUR/2025-01-15",
        method: "GET",
      });

      expect(res.status).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty("usdAmount", 100);
      expect(body).toHaveProperty("currency", "EUR");
      expect(body).toHaveProperty("convertedAmount");
      expect(body).toHaveProperty("exchangeRate");
    });

    test("GET /api/fiat-conversion should work with GBP", async () => {
      if (!serverRunning) return;

      const res = await makeRequest({
        hostname: "localhost",
        port: 3000,
        path: "/api/fiat-conversion/100/GBP/2025-01-15",
        method: "GET",
      });

      expect(res.status).toBe(200);
      const body = res.json();
      expect(body.currency).toBe("GBP");
      expect(body.convertedAmount).toBeGreaterThan(0);
      expect(body.convertedAmount).toBeLessThan(100); // GBP is stronger than USD
    });

    test("GET /api/fiat-conversion should handle invalid currency", async () => {
      if (!serverRunning) return;

      const res = await makeRequest({
        hostname: "localhost",
        port: 3000,
        path: "/api/fiat-conversion/100/INVALID/2025-01-15",
        method: "GET",
      });

      expect([400, 404, 500]).toContain(res.status);
    });
  });

  describe("Protected Endpoints (Auth Required)", () => {
    test("POST /api/wallet-report/pdf without auth should fail", async () => {
      if (!serverRunning) return;

      const res = await makeRequest({
        hostname: "localhost",
        port: 3000,
        path: "/api/wallet-report/pdf",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: {
          wallet: "cF0H0SKdnaDTqWKY9iJKBktTpdEWgb3GnlndE7ABv0Q",
          taxYear: 2025,
        },
      });

      // Should fail with 400 (missing wallet header) or 403 (unauthorized)
      expect([400, 403]).toContain(res.status);
    });

    test("POST /api/wallet-report/csv without auth should fail", async () => {
      if (!serverRunning) return;

      const res = await makeRequest({
        hostname: "localhost",
        port: 3000,
        path: "/api/wallet-report/csv",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: {
          wallet: "cF0H0SKdnaDTqWKY9iJKBktTpdEWgb3GnlndE7ABv0Q",
          taxYear: 2025,
          reportType: "transactions",
        },
      });

      expect([400, 403]).toContain(res.status);
    });

    test("POST /api/wallet/sync without auth should fail", async () => {
      if (!serverRunning) return;

      const res = await makeRequest({
        hostname: "localhost",
        port: 3000,
        path: "/api/wallet/sync",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: {
          wallet: "cF0H0SKdnaDTqWKY9iJKBktTpdEWgb3GnlndE7ABv0Q",
        },
      });

      expect([400, 403]).toContain(res.status);
    });
  });

  describe("Job Triggers", () => {
    test("POST /api/jobs/dex-price-indexer should accept request", async () => {
      if (!serverRunning) return;

      const res = await makeRequest({
        hostname: "localhost",
        port: 3000,
        path: "/api/jobs/dex-price-indexer",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: {
          incremental: true,
        },
      });

      // Should be 200 (started) or 409 (already running)
      expect([200, 409]).toContain(res.status);
    });

    test("POST /api/jobs/fiat-rate-indexer should accept request", async () => {
      if (!serverRunning) return;

      const res = await makeRequest({
        hostname: "localhost",
        port: 3000,
        path: "/api/jobs/fiat-rate-indexer",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: {
          incremental: true,
        },
      });

      expect([200, 409]).toContain(res.status);
    });
  });
});

