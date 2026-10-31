/**
 * WalletIdentity Model
 *
 * Represents a user's identity consisting of multiple Arweave wallets.
 * Internal transfers between these wallets are NOT taxable events.
 * This includes discovered Bazar profiles which are treated as additional wallets.
 *
 * This is the core model for multi-wallet tax tracking.
 * Note: Wallet limits are enforced at the API/auth layer, not here.
 */

class WalletIdentity {
  /**
   * Create a new wallet identity
   * @param {Object} config
   * @param {string} config.userId - Unique identifier for this identity
   * @param {string[]} config.wallets - Array of Arweave wallet addresses
   * @param {string} [config.primaryWallet] - Primary wallet address (for display)
   * @param {Object} [config.metadata] - Additional user metadata
   */
  constructor(config) {
    if (!config.wallets || config.wallets.length === 0) {
      throw new Error("At least one wallet address is required");
    }

    // Note: Wallet limits removed - enforced at API/auth layer instead
    // This allows internal indexing to include discovered Bazar profiles

    // Validate wallet addresses
    config.wallets.forEach((wallet) => {
      if (!this.isValidArweaveAddress(wallet)) {
        throw new Error(`Invalid Arweave address: ${wallet}`);
      }
    });

    this.userId = config.userId || this.generateUserId();
    this.wallets = [...new Set(config.wallets)]; // Remove duplicates
    this.primaryWallet = config.primaryWallet || this.wallets[0];
    this.metadata = config.metadata || {};
    this.createdAt = new Date();
    this.updatedAt = new Date();
  }

  /**
   * Check if an address belongs to this identity
   * @param {string} address - Arweave address to check
   * @returns {boolean}
   */
  ownsWallet(address) {
    return this.wallets.includes(address);
  }

  /**
   * Check if a transfer is internal (between user's own wallets)
   * @param {string} from - Sender address
   * @param {string} to - Recipient address
   * @returns {boolean}
   */
  isInternalTransfer(from, to) {
    return this.ownsWallet(from) && this.ownsWallet(to);
  }

  /**
   * Add a wallet to this identity
   * @param {string} address - Wallet address to add
   */
  addWallet(address) {
    if (!this.isValidArweaveAddress(address)) {
      throw new Error(`Invalid Arweave address: ${address}`);
    }

    if (!this.wallets.includes(address)) {
      this.wallets.push(address);
      this.updatedAt = new Date();
    }
  }

  /**
   * Remove a wallet from this identity
   * @param {string} address - Wallet address to remove
   */
  removeWallet(address) {
    if (this.wallets.length <= 1) {
      throw new Error("Cannot remove the last wallet from identity");
    }

    const index = this.wallets.indexOf(address);
    if (index > -1) {
      this.wallets.splice(index, 1);

      // Update primary if removed
      if (this.primaryWallet === address) {
        this.primaryWallet = this.wallets[0];
      }

      this.updatedAt = new Date();
    }
  }

  /**
   * Validate Arweave address format
   * @param {string} address
   * @returns {boolean}
   */
  isValidArweaveAddress(address) {
    if (typeof address !== "string") return false;
    return /^[A-Za-z0-9_-]{43}$/.test(address.trim());
  }

  /**
   * Generate a unique user ID
   * @returns {string}
   */
  generateUserId() {
    return `uid_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Serialize for storage
   * @returns {Object}
   */
  toJSON() {
    return {
      userId: this.userId,
      wallets: this.wallets,
      primaryWallet: this.primaryWallet,
      metadata: this.metadata,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }

  /**
   * Create from stored data
   * @param {Object} data
   * @returns {WalletIdentity}
   */
  static fromJSON(data) {
    const identity = new WalletIdentity({
      userId: data.userId,
      wallets: data.wallets,
      primaryWallet: data.primaryWallet,
      metadata: data.metadata,
    });
    identity.createdAt = new Date(data.createdAt);
    identity.updatedAt = new Date(data.updatedAt);
    return identity;
  }
}

module.exports = { WalletIdentity };
