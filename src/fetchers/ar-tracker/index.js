/**
 * Fetchers Index
 *
 * Exports all data fetching modules.
 *
 * @module fetchers
 */

const { AOTokenTransferFetcher } = require("./AOTokenTransferFetcher");
const { DEXSwapFetcher } = require("./DEXSwapFetcher");

module.exports = {
  AOTokenTransferFetcher,
  DEXSwapFetcher,
};
