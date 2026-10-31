/**
 * AO Message Tracer
 * 
 * Traces AO process messages to find result/response data.
 * Used for:
 * - Finding actual DEX swap output amounts (when not in input tags)
 * - Tracing Credit-Notice messages to their origin transactions
 * - Finding confirmation messages for agent orders
 * 
 * @module services/AOMessageTracer
 */

const axios = require('axios');
const CONSTANTS = require('../../../config/ar-tracker-constants');

class AOMessageTracer {
  constructor(options = {}) {
    this.gqlEndpoint = options.gqlEndpoint || CONSTANTS.GQL_ENDPOINTS.GOLDSKY;
    this.fallbackEndpoint = options.fallbackEndpoint || CONSTANTS.GQL_ENDPOINTS.ARWEAVE;
    this.verbose = options.verbose || false;
    this.timeout = options.timeout || 30000;
    
    // Cache for traced results
    this.resultCache = new Map();
  }

  log(...args) {
    if (this.verbose) {
      console.log('[AOMessageTracer]', ...args);
    }
  }

  /**
   * Execute GraphQL query with fallback
   */
  async executeQuery(query, variables = {}) {
    try {
      const response = await axios.post(
        this.gqlEndpoint,
        { query, variables },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: this.timeout
        }
      );
      return response.data?.data;
    } catch (error) {
      // Try fallback
      try {
        const response = await axios.post(
          this.fallbackEndpoint,
          { query, variables },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: this.timeout
          }
        );
        return response.data?.data;
      } catch (fallbackError) {
        this.log(`Query failed on both endpoints: ${error.message}`);
        return null;
      }
    }
  }

  /**
   * Parse tags array into object
   */
  parseTags(tags) {
    const result = {};
    if (!tags) return result;
    for (const tag of tags) {
      result[tag.name] = tag.value;
    }
    return result;
  }

  /**
   * Find result message for a transaction using Pushed-For tag
   * This is the standard AO pattern: result messages reference the original via Pushed-For
   */
  async findResultMessage(originalTxId, expectedActions = []) {
    // Check cache
    if (this.resultCache.has(originalTxId)) {
      return this.resultCache.get(originalTxId);
    }

    const query = `
      query FindResultMessage($txId: [String!]!, $actions: [String!]) {
        transactions(
          first: 10
          tags: [
            { name: "Pushed-For", values: $txId },
            ${expectedActions.length > 0 ? '{ name: "Action", values: $actions }' : ''}
          ]
          sort: HEIGHT_DESC
        ) {
          edges {
            node {
              id
              block { height timestamp }
              tags { name value }
            }
          }
        }
      }
    `;

    const variables = { txId: [originalTxId] };
    if (expectedActions.length > 0) {
      variables.actions = expectedActions;
    }

    const data = await this.executeQuery(query, variables);
    const edges = data?.transactions?.edges || [];

    if (edges.length === 0) {
      this.resultCache.set(originalTxId, null);
      return null;
    }

    const results = edges.map(edge => ({
      txId: edge.node.id,
      blockHeight: edge.node.block?.height,
      blockTimestamp: edge.node.block?.timestamp,
      tags: this.parseTags(edge.node.tags)
    }));

    this.resultCache.set(originalTxId, results);
    return results;
  }

  /**
   * Trace DEX swap to find actual output amount
   * Works for:
   * - Agent orders (look for completion notices)
   * - Bazar trades (look for Credit-Notice with actual amount)
   */
  async traceSwapOutput(swap) {
    if (!swap || !swap.txId) return null;

    // Skip if we already have output amount
    if (swap.amountOut && swap.amountOut !== '0' && swap.amountOut !== swap.minOutput) {
      return {
        hasOutput: true,
        outputAmount: swap.amountOut,
        source: 'tags'
      };
    }

    this.log(`Tracing output for swap ${swap.txId}...`);

    // Different tracing strategies based on platform
    if (swap.platform === 'botega_agent') {
      return this.traceAgentOrderOutput(swap);
    } else if (swap.platform === 'bazar') {
      return this.traceBazarTradeOutput(swap);
    }

    return null;
  }

  /**
   * Trace agent order to find actual fill amount
   * Agent orders may be partially or fully filled
   */
  async traceAgentOrderOutput(order) {
    // Look for Credit-Notice from the output token process
    const query = `
      query FindAgentOrderFill($recipient: [String!]!, $tokenProcess: [String!]!) {
        transactions(
          first: 20
          recipients: $recipient
          tags: [
            { name: "Action", values: ["Credit-Notice"] },
            { name: "From-Process", values: $tokenProcess }
          ]
          sort: HEIGHT_DESC
        ) {
          edges {
            node {
              id
              block { height timestamp }
              tags { name value }
            }
          }
        }
      }
    `;

    const variables = {
      recipient: [order.walletAddress],
      tokenProcess: [order.tokenOut]
    };

    const data = await this.executeQuery(query, variables);
    const edges = data?.transactions?.edges || [];

    // Find Credit-Notice that references this order
    for (const edge of edges) {
      const tags = this.parseTags(edge.node.tags);
      
      // Check if this Credit-Notice is related to our order
      const xReference = tags['X-Reference'];
      const pushedFor = tags['Pushed-For'];
      const reference = tags['Reference'];
      
      if (xReference === order.txId || pushedFor === order.txId || reference === order.txId) {
        const quantity = tags['Quantity'];
        if (quantity) {
          return {
            hasOutput: true,
            outputAmount: quantity,
            outputTxId: edge.node.id,
            source: 'credit_notice',
            timestamp: edge.node.block?.timestamp
          };
        }
      }
    }

    // Alternative: Check for Order-Complete message
    const resultMessages = await this.findResultMessage(order.txId, ['Order-Complete', 'Swap-Complete']);
    if (resultMessages && resultMessages.length > 0) {
      for (const result of resultMessages) {
        const outputAmount = result.tags['Output-Amount'] || result.tags['Amount-Out'] || result.tags['Quantity'];
        if (outputAmount) {
          return {
            hasOutput: true,
            outputAmount,
            outputTxId: result.txId,
            source: 'completion_notice',
            timestamp: result.blockTimestamp
          };
        }
      }
    }

    // Use Min-Output as fallback if order is complete
    if (order.status === 'Complete' && order.minOutput) {
      return {
        hasOutput: true,
        outputAmount: order.minOutput,
        source: 'min_output_fallback',
        isEstimate: true
      };
    }

    return { hasOutput: false };
  }

  /**
   * Trace Bazar UCM trade to find actual fill amount
   */
  async traceBazarTradeOutput(trade) {
    // For Bazar trades, the Quantity in the order might not be the actual fill
    // Look for Order-Fill or Credit-Notice messages
    
    const resultMessages = await this.findResultMessage(trade.txId, ['Order-Fill', 'Order-Matched', 'Order-Complete']);
    
    if (resultMessages && resultMessages.length > 0) {
      for (const result of resultMessages) {
        const fillQuantity = result.tags['Fill-Quantity'] || result.tags['Quantity'];
        const fillPrice = result.tags['Fill-Price'] || result.tags['Price'];
        
        if (fillQuantity) {
          return {
            hasOutput: true,
            outputAmount: fillQuantity,
            price: fillPrice,
            outputTxId: result.txId,
            source: 'order_fill',
            timestamp: result.blockTimestamp
          };
        }
      }
    }

    // For matched orders, the quantity in tags should be accurate
    if (trade.incomingSide && trade.quantity) {
      return {
        hasOutput: true,
        outputAmount: trade.quantity,
        source: 'order_tags'
      };
    }

    return { hasOutput: false };
  }

  /**
   * Batch trace multiple swaps
   */
  async batchTraceSwapOutputs(swaps, options = {}) {
    const { concurrency = 5, onProgress } = options;
    const results = [];
    let processed = 0;

    // Process in batches
    for (let i = 0; i < swaps.length; i += concurrency) {
      const batch = swaps.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(swap => this.traceSwapOutput(swap))
      );
      
      for (let j = 0; j < batch.length; j++) {
        results.push({
          swap: batch[j],
          trace: batchResults[j]
        });
      }
      
      processed += batch.length;
      if (onProgress) {
        onProgress(processed, swaps.length);
      }
      
      // Small delay between batches
      if (i + concurrency < swaps.length) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    return results;
  }

  /**
   * Find Credit-Notice for an outgoing transfer
   * Used to verify that tokens were actually received by recipient
   */
  async findCreditNotice(debitTxId, tokenProcess, recipient) {
    const query = `
      query FindCreditNotice($recipient: [String!]!, $token: [String!]!) {
        transactions(
          first: 10
          recipients: $recipient
          tags: [
            { name: "Action", values: ["Credit-Notice"] },
            { name: "From-Process", values: $token },
            { name: "Pushed-For", values: ["${debitTxId}"] }
          ]
        ) {
          edges {
            node {
              id
              block { height timestamp }
              tags { name value }
            }
          }
        }
      }
    `;

    const data = await this.executeQuery(query, { recipient: [recipient], token: [tokenProcess] });
    const edges = data?.transactions?.edges || [];

    if (edges.length === 0) {
      return null;
    }

    const tags = this.parseTags(edges[0].node.tags);
    return {
      txId: edges[0].node.id,
      quantity: tags['Quantity'],
      sender: tags['Sender'],
      blockTimestamp: edges[0].node.block?.timestamp
    };
  }

  /**
   * Trace message chain for complex multi-hop transactions
   */
  async traceMessageChain(startTxId, maxDepth = 5) {
    const chain = [];
    let currentTxId = startTxId;
    let depth = 0;

    while (depth < maxDepth) {
      const results = await this.findResultMessage(currentTxId, []);
      if (!results || results.length === 0) break;

      chain.push(...results);
      
      // Continue tracing from the first result
      currentTxId = results[0].txId;
      depth++;
    }

    return chain;
  }

  /**
   * Enrich swap transactions with traced output data
   */
  async enrichSwapsWithOutputs(swaps) {
    const needsTracing = swaps.filter(swap => 
      !swap.amountOut || swap.amountOut === '0' || swap.amountOut === swap.minOutput
    );

    if (needsTracing.length === 0) {
      this.log('All swaps have output amounts, no tracing needed');
      return swaps;
    }

    this.log(`Tracing output amounts for ${needsTracing.length} swaps...`);

    const traceResults = await this.batchTraceSwapOutputs(needsTracing, {
      onProgress: (done, total) => {
        if (done % 10 === 0 || done === total) {
          this.log(`  Traced ${done}/${total} swaps`);
        }
      }
    });

    // Update swaps with traced data
    for (const { swap, trace } of traceResults) {
      if (trace && trace.hasOutput) {
        swap.amountOut = trace.outputAmount;
        swap.amountOutSource = trace.source;
        swap.outputTxId = trace.outputTxId;
        swap.outputTraced = true;
        
        if (trace.isEstimate) {
          swap.outputIsEstimate = true;
        }
      }
    }

    return swaps;
  }
}

module.exports = { AOMessageTracer };

