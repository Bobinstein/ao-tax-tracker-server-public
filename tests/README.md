# Test Suite

This directory contains tests for the AO Tax Tracker Server.

## Running Tests

```bash
# Run all tests
yarn test

# Run tests in watch mode (re-run on file changes)
yarn test:watch

# Run tests with coverage report
yarn test:coverage

# Run only API tests
yarn test:api

# Run only unit tests
yarn test:unit
```

## Test Structure

### `setup.js`
Test utilities, mock classes, and helper functions:
- `MockCassandraClient` - Mock Cassandra client for unit tests
- `TEST_WALLETS` - Test wallet addresses
- `createMockTransaction()` - Create mock transaction data
- `createMockDEXSwap()` - Create mock DEX swap data
- `createMockDistribution()` - Create mock distribution data
- `createMockTaxLot()` - Create mock tax lot data

### `costBasis.test.js`
Tests for cost basis calculations:
- FIFO (First In, First Out) method
- LIFO (Last In, First Out) method
- HIFO (Highest In, First Out) method
- Gain/loss calculations
- Long-term vs short-term classification
- DEX swap cost basis

### `models.test.js`
Tests for data models:
- UnifiedTransaction model
- TaxLot model
- Disposal model
- DEX Swap model
- Internal transfer detection
- Value calculations

### `api.test.js`
Tests for API endpoints:
- Health check (`GET /health`)
- API info (`GET /`)
- Job status (`GET /api/status`)
- DEX prices (`GET /api/dex-prices/:token/:date`)
- Fiat conversion (`GET /api/fiat-conversion/:amount/:currency/:date`)
- Protected endpoints (auth required)
- Job triggers

## Test Types

### Unit Tests
- Run without server
- Use mock Cassandra client
- Fast execution
- Test business logic

### API Tests
- Require server running on localhost:3000
- Test real HTTP endpoints
- Skip automatically if server not running

## Coverage

Current coverage is low because:
1. Most tests use mocks rather than real implementations
2. Integration tests require live database connections

To improve coverage:
1. Add more unit tests with mock data
2. Add integration tests with test database
3. Test error handling paths

## Adding New Tests

1. Create new test file in `tests/` directory
2. Import utilities from `setup.js`
3. Use Jest test patterns:

```javascript
const { createMockTransaction } = require("./setup");

describe("Feature", () => {
  test("should do something", () => {
    const data = createMockTransaction({ type: "SEND" });
    expect(data.type).toBe("SEND");
  });
});
```

## Continuous Integration

Tests run on:
- Pre-commit (recommended)
- Pull request validation
- Deployment pipeline

## Test Wallets

The following test wallets are used:
- `cF0H0SKdnaDTqWKY9iJKBktTpdEWgb3GnlndE7ABv0Q`
- `pZkvXGaicIvbxLRM7PiiO3AV-F3dQbas-Vp7sH71xOE`
- `GtDQcrr2QRdoZ-lKto_S_SpzEwiZiHVaj3x4jAgRh4o`
- `uzESID1JQp8m4RO7YjfVZ8eWtRsSrxLp1SilTj7psB8`

These wallets have test data in the development database.

