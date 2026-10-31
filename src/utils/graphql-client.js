#!/usr/bin/env node

/**
 * Robust GraphQL Client with retry logic and error handling
 *
 * Handles common GraphQL issues:
 * - Incomplete JSON responses
 * - Network timeouts
 * - Rate limiting
 * - Server errors
 * - Connection issues
 */

const https = require("https");
const http = require("http");

class GraphQLClient {
  constructor(options = {}) {
    this.endpoints = options.endpoints || [
      "https://arweave-search.goldsky.com/graphql",
      "https://arweave.net/graphql",
    ];
    this.maxRetries = options.maxRetries || 3;
    this.retryDelay = options.retryDelay || 1000; // 1 second base delay
    this.timeout = options.timeout || 30000; // 30 seconds
    this.userAgent = options.userAgent || "AO-Tax-Tracker/1.0";
    this.currentEndpointIndex = 0;
  }

  /**
   * Execute a GraphQL query with retry logic
   */
  async execute(query, variables = {}, options = {}) {
    const maxRetries = options.maxRetries || this.maxRetries;
    const retryDelay = options.retryDelay || this.retryDelay;

    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔍 GraphQL attempt ${attempt}/${maxRetries}...`);

        const result = await this._makeRequest(query, variables, options);

        if (result) {
          console.log(`✅ GraphQL request successful on attempt ${attempt}`);
          return result;
        }
      } catch (error) {
        lastError = error;
        console.log(`⚠️  GraphQL attempt ${attempt} failed: ${error.message}`);

        // Don't retry on certain errors
        if (this._shouldNotRetry(error)) {
          console.log(`❌ Not retrying due to error type: ${error.message}`);
          throw error;
        }

        // Switch to next endpoint if available
        if (attempt < maxRetries) {
          this._switchEndpoint();
          const delay = retryDelay * Math.pow(2, attempt - 1); // Exponential backoff
          console.log(`⏳ Waiting ${delay}ms before retry...`);
          await this._sleep(delay);
        }
      }
    }

    console.log(`❌ All GraphQL attempts failed after ${maxRetries} retries`);
    throw lastError || new Error("GraphQL request failed after all retries");
  }

  /**
   * Make the actual HTTP request
   */
  async _makeRequest(query, variables, options) {
    return new Promise((resolve, reject) => {
      const endpoint = this.endpoints[this.currentEndpointIndex];
      const url = new URL(endpoint);

      const postData = JSON.stringify({
        query,
        variables,
      });

      const requestOptions = {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
          "User-Agent": this.userAgent,
          Accept: "application/json",
          Connection: "keep-alive",
        },
        timeout: this.timeout,
      };

      const client = url.protocol === "https:" ? https : http;
      const req = client.request(requestOptions, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          try {
            // Check for empty response
            if (!data || data.trim() === "") {
              throw new Error("Empty response from server");
            }

            // Check for HTML error pages
            if (data.trim().startsWith("<")) {
              throw new Error(
                "Received HTML instead of JSON (likely error page)",
              );
            }

            // Parse JSON
            const result = JSON.parse(data);

            // Check for GraphQL errors
            if (result.errors && result.errors.length > 0) {
              const errorMessages = result.errors
                .map((e) => e.message)
                .join("; ");
              throw new Error(`GraphQL errors: ${errorMessages}`);
            }

            // Check for valid data structure
            if (result.data === undefined) {
              throw new Error("Invalid response structure: missing data field");
            }

            resolve(result);
          } catch (parseError) {
            console.log(`❌ JSON parse error: ${parseError.message}`);
            console.log(`📄 Response preview: ${data.substring(0, 200)}...`);
            reject(new Error(`JSON parse error: ${parseError.message}`));
          }
        });
      });

      req.on("error", (error) => {
        reject(new Error(`Request error: ${error.message}`));
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Request timeout after ${this.timeout}ms`));
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Switch to the next available endpoint
   */
  _switchEndpoint() {
    this.currentEndpointIndex =
      (this.currentEndpointIndex + 1) % this.endpoints.length;
    console.log(
      `🔄 Switching to endpoint: ${this.endpoints[this.currentEndpointIndex]}`,
    );
  }

  /**
   * Check if error should not be retried
   */
  _shouldNotRetry(error) {
    const message = error.message.toLowerCase();

    // Don't retry on authentication errors
    if (message.includes("unauthorized") || message.includes("forbidden")) {
      return true;
    }

    // Don't retry on GraphQL query syntax errors (but DO retry JSON parse errors from server issues)
    if (message.includes("syntax error") && !message.includes("json")) {
      return true;
    }

    // Don't retry on invalid query structure (GraphQL errors, not JSON parsing)
    if (message.includes("graphql errors")) {
      return true;
    }

    // DO retry on JSON parse errors (empty response, server issues)
    // These are transient and should be retried with endpoint switch
    if (
      message.includes("json parse error") ||
      message.includes("empty response")
    ) {
      return false;
    }

    return false;
  }

  /**
   * Sleep utility
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get current endpoint
   */
  getCurrentEndpoint() {
    return this.endpoints[this.currentEndpointIndex];
  }

  /**
   * Reset to first endpoint
   */
  resetEndpoint() {
    this.currentEndpointIndex = 0;
  }
}

module.exports = GraphQLClient;
