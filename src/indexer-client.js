// Copyright 2026 Zerion
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

'use strict'

/**
 * @typedef {Object} ChainAmount
 * @property {string} chain - Chain identifier (e.g. 'ethereum', 'arbitrum', 'solana')
 * @property {number} value - USD value held on this chain
 */

/**
 * @typedef {Object} PortfolioSummary
 * @property {string} address - Wallet address
 * @property {number} totalValue - Total USD value across all chains and position types
 * @property {number} walletValue - USD value held in plain wallet positions (tokens)
 * @property {number} depositedValue - USD value held in DeFi deposit positions
 * @property {number} borrowedValue - USD value of outstanding DeFi borrow positions (negative contribution)
 * @property {number} stakedValue - USD value held in staked positions
 * @property {number} change24hAbsolute - Absolute USD change over the last 24h
 * @property {number} change24hPercent - Percent change over the last 24h (e.g. 1.5 = +1.5%)
 * @property {ChainAmount[]} byChain - USD value by chain
 * @property {number} fetchedAt - Unix ms timestamp when this snapshot was fetched
 */

/**
 * @typedef {Object} TokenPosition
 * @property {string} id - Position identifier
 * @property {string} type - Position type ('wallet' | 'deposit' | 'loan' | 'staked' | ...)
 * @property {string|null} protocol - Protocol name (null if plain wallet position)
 * @property {string} chain - Chain identifier
 * @property {string} symbol - Token symbol
 * @property {string} name - Token name
 * @property {string|null} contractAddress - Token contract (null for native or unmatched chain)
 * @property {string} quantity - Quantity as a precision-preserving decimal string
 * @property {number} valueUsd - USD value of this position (display-only)
 * @property {number} priceUsd - Price per unit in USD (display-only)
 * @property {number} change24hPercent - 24h price change percent
 */

/**
 * @typedef {Object} PositionsQuery
 * @property {string[]} [chains] - Filter to specific chains
 * @property {string[]} [positionTypes] - Filter to specific position types
 * @property {number} [limit=100] - Page size (clamped to 100 by Zerion)
 * @property {string} [cursor] - Pagination cursor from a previous response
 */

/**
 * @typedef {Object} PositionsResult
 * @property {string} address
 * @property {TokenPosition[]} positions
 * @property {string|null} nextCursor - Cursor for next page (null if no more pages)
 * @property {number} fetchedAt
 */

/**
 * @typedef {Object} TransactionTransfer
 * @property {'in'|'out'|'self'} direction
 * @property {string} symbol
 * @property {string} quantity - Precision-preserving decimal string
 * @property {number} valueUsd
 * @property {string} fromAddress
 * @property {string} toAddress
 */

/**
 * @typedef {Object} InterpretedTransaction
 * @property {string} hash - Transaction hash
 * @property {string} chain - Chain identifier
 * @property {string} type - Interpreted action ('send' | 'receive' | 'trade' | 'deposit' | 'borrow' | 'repay' | 'mint' | 'burn' | 'execute' | 'approve' | ...)
 * @property {string|null} protocol - Protocol involved (null if generic transfer)
 * @property {number} timestamp - Unix ms timestamp
 * @property {string} status - 'confirmed' | 'failed' | 'pending'
 * @property {TransactionTransfer[]} transfers - Token movements relevant to the queried address
 * @property {number} feeUsd - Network fee in USD (display-only)
 */

/**
 * @typedef {Object} TransactionsQuery
 * @property {number} [limit=50]
 * @property {string[]} [chains] - Filter to specific chains
 * @property {string} [cursor] - Pagination cursor from a previous response
 */

/**
 * @typedef {Object} TransactionsResult
 * @property {string} address
 * @property {InterpretedTransaction[]} transactions
 * @property {string|null} nextCursor
 * @property {number} fetchedAt
 */

/**
 * @typedef {Object} NftPosition
 * @property {string} chain
 * @property {string} contractAddress
 * @property {string} tokenId
 * @property {string} name
 * @property {string} collectionName
 * @property {string} imageUrl
 * @property {number|null} floorPriceUsd
 * @property {number|null} lastPriceUsd
 */

/**
 * @typedef {Object} NftsResult
 * @property {string} address
 * @property {NftPosition[]} nfts
 * @property {string|null} nextCursor
 * @property {number} fetchedAt
 */

/**
 * @typedef {Object} PnlSummary
 * @property {string} address
 * @property {number} realizedPnlUsd
 * @property {number} unrealizedPnlUsd
 * @property {number} totalPnlUsd
 * @property {number} totalFeesUsd - Total network fees paid (USD)
 * @property {number} netInvestedUsd - Net amount invested (deposits - withdrawals) measured in USD at txn time
 * @property {number} fetchedAt
 */

/**
 * Abstract indexer interface for WDK.
 *
 * Mirrors the existing `PricingClient` pattern in
 * `@tetherto/wdk-pricing-provider`: an abstract base any vendor can
 * implement, then plugged into a higher-level provider.
 *
 * The first concrete implementation is `ZerionIndexerClient`. Other
 * providers (Alchemy, Covalent, etc.) can subclass this same interface.
 *
 * Designed to be PR-able into `@tetherto/wdk-wallet` as a sibling to
 * `WalletManager`/`WalletAccount`/`WalletAccountReadOnly`.
 */
export class WalletIndexerClient {
  /**
   * @param {string} address
   * @returns {Promise<PortfolioSummary>}
   */
  async getPortfolio(address) {
    throw new Error('WalletIndexerClient.getPortfolio not implemented')
  }

  /**
   * @param {string} address
   * @param {PositionsQuery} [query]
   * @returns {Promise<PositionsResult>}
   */
  async getPositions(address, query = {}) {
    throw new Error('WalletIndexerClient.getPositions not implemented')
  }

  /**
   * @param {string} address
   * @param {TransactionsQuery} [query]
   * @returns {Promise<TransactionsResult>}
   */
  async getTransactions(address, query = {}) {
    throw new Error('WalletIndexerClient.getTransactions not implemented')
  }

  /**
   * @param {string} address
   * @param {{ chains?: string[], limit?: number, cursor?: string }} [opts]
   * @returns {Promise<NftsResult>}
   */
  async getNfts(address, opts = {}) {
    throw new Error('WalletIndexerClient.getNfts not implemented')
  }

  /**
   * @param {string} address
   * @returns {Promise<PnlSummary>}
   */
  async getPnl(address) {
    throw new Error('WalletIndexerClient.getPnl not implemented')
  }
}
