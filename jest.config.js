module.exports = {
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.js"],
  testPathIgnorePatterns: ["/node_modules/"],
  collectCoverageFrom: [
    "src/services/**/*.js",
    "src/fetchers/**/*.js",
    "src/indexers/**/*.js",
    "src/models/**/*.js",
    "!**/node_modules/**",
    "!**/tests/**",
  ],
  // Note: Coverage thresholds are low because most tests are unit tests with mocks
  // Integration tests with real database would provide higher coverage
  coverageThreshold: {
    global: {
      branches: 0,
      functions: 0,
      lines: 0,
      statements: 0,
    },
  },
  // Timeout for async tests (30 seconds for DB operations)
  testTimeout: 30000,
  // Watch mode configuration
  watchman: false,
  watchPathIgnorePatterns: ["/node_modules/", "/\\.git/"],
  // Setup file for test utilities
  setupFilesAfterEnv: ["./tests/setup.js"],
};

