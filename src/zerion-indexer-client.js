// Copyright 2026 Zerion
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

'use strict'

import { WalletIndexerClient } from './indexer-client.js'

const DEFAULT_BASE_URL = 'https://api.zerion.io'
const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_USER_AGENT = '@zerion/wdk-indexer-zerion'
const MAX_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 50
const MAX_ERROR_BODY_BYTES = 4096

// Conservative whitelist character set for Zerion chain identifiers.
// Real chain ids are short kebab/snake-case slugs (e.g. 'ethereum', 'arbitrum-one',
// 'optimism', 'polygon-pos'). This rejects junk before it hits the wire.
const CHAIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/

// Address shapes we currently expect to forward. Validated case-insensitively;
// the original string is preserved on the wire. Non-matching values are rejected
// to avoid accidental path traversal or header smuggling via the path component.
const ADDRESS_PATTERNS = [
  /^0x[0-9a-fA-F]{40}$/,            // EVM
  /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,  // Solana base58
]

/**
 * @typedef {Object} ZerionIndexerClientOptions
 * @property {string} apiKey - Zerion API key (e.g. 'zk_dev_...' or 'zk_prod_...')
 * @property {string} [baseUrl] - Override base URL (defaults to https://api.zerion.io)
 * @property {string} [environment] - 'production' (default) or 'testnet'. Maps to the X-Env header.
 * @property {string} [currency] - Settlement currency for value fields. Defaults to 'usd'.
 * @property {number} [timeoutMs] - Per-request timeout in ms (defaults to 15000)
 * @property {string} [userAgent]
 * @property {typeof fetch} [fetch] - Inject a fetch implementation (defaults to global fetch)
 */

/**
 * Concrete `WalletIndexerClient` backed by the Zerion API.
 *
 * Auth: HTTP Basic with the API key as the username and an empty password.
 *   Authorization: Basic base64(`${apiKey}:`)
 *
 * Docs: https://developers.zerion.io
 */
export class ZerionIndexerClient extends WalletIndexerClient {
  /** @param {ZerionIndexerClientOptions} options */
  constructor(options = {}) {
    super()
    if (!options.apiKey || typeof options.apiKey !== 'string') {
      throw new Error('ZerionIndexerClient: `apiKey` is required')
    }
    /** @internal */
    this.apiKey = options.apiKey
    /** @internal */
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')
    /** @internal */
    this.environment = options.environment || 'production'
    /** @internal */
    this.currency = options.currency || 'usd'
    /** @internal */
    this.timeoutMs = numberOr(options.timeoutMs, DEFAULT_TIMEOUT_MS)
    /** @internal */
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT
    /** @internal */
    this.fetchImpl = options.fetch || globalThis.fetch
    if (typeof this.fetchImpl !== 'function') {
      throw new Error(
        'ZerionIndexerClient: global fetch is unavailable. Provide options.fetch or run on Node 18+.',
      )
    }
  }

  /**
   * Returns a high-level multi-chain portfolio snapshot for an address.
   * @param {string} address
   * @returns {Promise<import('./indexer-client.js').PortfolioSummary>}
   */
  async getPortfolio(address) {
    const safeAddress = sanitizeAddress(address)
    const json = await this._get(`/v1/wallets/${safeAddress}/portfolio`, {
      currency: this.currency,
    })
    const attrs = json?.data?.attributes ?? {}
    const distribution = isPlainObject(attrs.positions_distribution_by_chain)
      ? attrs.positions_distribution_by_chain
      : {}
    const totals = isPlainObject(attrs.positions_distribution_by_type)
      ? attrs.positions_distribution_by_type
      : {}
    const totalUsd = attrs.total?.positions ?? 0
    const change24h = isPlainObject(attrs.changes) ? attrs.changes : {}

    return {
      address,
      totalValue: numberOr(totalUsd, 0),
      walletValue: numberOr(totals.wallet, 0),
      depositedValue: numberOr(totals.deposited, 0),
      borrowedValue: numberOr(totals.borrowed, 0),
      stakedValue: numberOr(totals.staked, 0),
      change24hAbsolute: numberOr(change24h.absolute_1d, 0),
      change24hPercent: numberOr(change24h.percent_1d, 0),
      byChain: Object.entries(distribution).map(([chain, value]) => ({
        chain,
        value: numberOr(value, 0),
      })),
      fetchedAt: Date.now(),
    }
  }

  /**
   * Returns the full list of token + DeFi positions held by an address.
   * @param {string} address
   * @param {import('./indexer-client.js').PositionsQuery} [query]
   * @returns {Promise<import('./indexer-client.js').PositionsResult>}
   */
  async getPositions(address, query = {}) {
    const safeAddress = sanitizeAddress(address)
    const limit = clampLimit(query.limit ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE)
    const params = { currency: this.currency, 'page[size]': limit }
    if (Array.isArray(query.chains) && query.chains.length) {
      params['filter[chain_ids]'] = sanitizeChainList(query.chains).join(',')
    }
    if (Array.isArray(query.positionTypes) && query.positionTypes.length) {
      params['filter[position_types]'] = query.positionTypes.join(',')
    }
    if (typeof query.cursor === 'string' && query.cursor.length > 0) {
      params['page[after]'] = query.cursor
    }

    const json = await this._get(`/v1/wallets/${safeAddress}/positions`, params)
    const data = Array.isArray(json?.data) ? json.data : []
    const positions = data.map(parsePositionResource)
    const nextCursor = extractNextCursor(json?.links?.next, this.baseUrl)
    return {
      address,
      positions,
      nextCursor,
      fetchedAt: Date.now(),
    }
  }

  /**
   * Returns interpreted transaction history for an address.
   * @param {string} address
   * @param {import('./indexer-client.js').TransactionsQuery} [query]
   * @returns {Promise<import('./indexer-client.js').TransactionsResult>}
   */
  async getTransactions(address, query = {}) {
    const safeAddress = sanitizeAddress(address)
    const limit = clampLimit(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
    const params = { currency: this.currency, 'page[size]': limit }
    if (Array.isArray(query.chains) && query.chains.length) {
      params['filter[chain_ids]'] = sanitizeChainList(query.chains).join(',')
    }
    if (typeof query.cursor === 'string' && query.cursor.length > 0) {
      params['page[after]'] = query.cursor
    }

    const json = await this._get(`/v1/wallets/${safeAddress}/transactions`, params)
    const data = Array.isArray(json?.data) ? json.data : []
    const transactions = data.map((tx) => parseTransactionResource(tx, address))
    const nextCursor = extractNextCursor(json?.links?.next, this.baseUrl)
    return {
      address,
      transactions,
      nextCursor,
      fetchedAt: Date.now(),
    }
  }

  /**
   * Returns NFT holdings for an address with floor and last-sale prices.
   * @param {string} address
   * @param {{ chains?: string[], limit?: number, cursor?: string }} [opts]
   * @returns {Promise<import('./indexer-client.js').NftsResult>}
   */
  async getNfts(address, opts = {}) {
    const safeAddress = sanitizeAddress(address)
    const params = {
      currency: this.currency,
      'page[size]': clampLimit(opts.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
    }
    if (Array.isArray(opts.chains) && opts.chains.length) {
      params['filter[chain_ids]'] = sanitizeChainList(opts.chains).join(',')
    }
    if (typeof opts.cursor === 'string' && opts.cursor.length > 0) {
      params['page[after]'] = opts.cursor
    }

    const json = await this._get(`/v1/wallets/${safeAddress}/nft-positions`, params)
    const data = Array.isArray(json?.data) ? json.data : []
    const nfts = data.map(parseNftResource)
    const nextCursor = extractNextCursor(json?.links?.next, this.baseUrl)
    return {
      address,
      nfts,
      nextCursor,
      fetchedAt: Date.now(),
    }
  }

  /**
   * Returns realized + unrealized PnL summary for an address.
   * @param {string} address
   * @returns {Promise<import('./indexer-client.js').PnlSummary>}
   */
  async getPnl(address) {
    const safeAddress = sanitizeAddress(address)
    const json = await this._get(`/v1/wallets/${safeAddress}/pnl`, {
      currency: this.currency,
    })
    const attrs = isPlainObject(json?.data?.attributes) ? json.data.attributes : {}
    const realized = numberOr(attrs.realized_gain, 0)
    const unrealized = numberOr(attrs.unrealized_gain, 0)
    const totalGain = attrs.total_gain != null ? numberOr(attrs.total_gain, realized + unrealized) : realized + unrealized
    return {
      address,
      realizedPnlUsd: realized,
      unrealizedPnlUsd: unrealized,
      totalPnlUsd: totalGain,
      totalFeesUsd: numberOr(attrs.total_fee, 0),
      netInvestedUsd: numberOr(attrs.net_invested, 0),
      fetchedAt: Date.now(),
    }
  }

  // ----- internal HTTP -----

  /**
   * @internal
   * @param {string} path
   * @param {Record<string, string|number>} [params]
   * @returns {Promise<any>}
   */
  async _get(path, params = {}) {
    const url = new URL(this.baseUrl + path)
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v))
      }
    }

    const controller = new AbortController()
    // Timer covers the full request lifetime — including streaming the body —
    // because the AbortSignal is passed into both fetch() and the
    // response.json() / response.text() reads via the same controller.
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    let response
    try {
      response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: this._headers(),
        signal: controller.signal,
        // Refuse to follow cross-origin redirects so the Authorization
        // header can never be replayed against an attacker-controlled host.
        redirect: 'error',
      })

      if (!response.ok) {
        const bodyText = await safeText(response, controller.signal, MAX_ERROR_BODY_BYTES)
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
        throw new ZerionApiError(
          `Zerion API ${response.status} ${response.statusText} on ${path}`,
          {
            status: response.status,
            url: url.toString(),
            body: bodyText,
            retryAfterSeconds: retryAfter,
          },
        )
      }

      return await readJson(response, controller.signal)
    } catch (err) {
      if (err instanceof ZerionApiError) throw err
      if (err?.name === 'AbortError') {
        throw new ZerionApiError(
          `Zerion API request timed out after ${this.timeoutMs}ms`,
          { status: 0, url: url.toString(), cause: err },
        )
      }
      throw new ZerionApiError(`Zerion API network error: ${err?.message ?? err}`, {
        status: 0,
        url: url.toString(),
        cause: err,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  /** @internal */
  _headers() {
    const token = base64Encode(`${this.apiKey}:`)
    return {
      Accept: 'application/json',
      Authorization: `Basic ${token}`,
      'X-Env': this.environment,
      'User-Agent': this.userAgent,
    }
  }
}

export class ZerionApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status: number, url?: string, body?: string, cause?: unknown, retryAfterSeconds?: number|null }} info
   */
  constructor(message, info) {
    // Preserve the underlying cause via the standard Error options bag so
    // `.cause` is set on engines that natively support it (Node 16.9+).
    super(message, info?.cause !== undefined ? { cause: info.cause } : undefined)
    this.name = 'ZerionApiError'
    this.status = info.status
    this.url = info.url
    this.body = info.body
    this.retryAfterSeconds = info.retryAfterSeconds ?? null
  }
}

// ----- helpers -----

function sanitizeAddress(address) {
  if (typeof address !== 'string') {
    throw new TypeError('address must be a string')
  }
  const trimmed = address.trim()
  if (trimmed.length === 0) {
    throw new TypeError('address must be a non-empty string')
  }
  if (!ADDRESS_PATTERNS.some((re) => re.test(trimmed))) {
    throw new TypeError(
      `address ${JSON.stringify(trimmed)} does not match a supported format (EVM 0x… or Solana base58)`,
    )
  }
  // encodeURIComponent is belt-and-braces; the regex above already excludes
  // anything that would need encoding, but defends against future shape additions.
  return encodeURIComponent(trimmed)
}

function sanitizeChainList(chains) {
  return chains.map((c) => {
    if (typeof c !== 'string' || !CHAIN_ID_PATTERN.test(c)) {
      throw new TypeError(`invalid chain id ${JSON.stringify(c)}`)
    }
    return c
  })
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

function numberOr(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function clampLimit(n, max) {
  const v = Math.floor(Number(n))
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_PAGE_SIZE
  return Math.min(v, max)
}

function base64Encode(str) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(str, 'utf-8').toString('base64')
  }
  // Browser fallback
  // eslint-disable-next-line no-undef
  return btoa(unescape(encodeURIComponent(str)))
}

async function readJson(response, signal) {
  // Reading the body shares the request's AbortSignal, so a slow trickling
  // server still trips the timeoutMs ceiling instead of hanging forever.
  const text = await readText(response, signal)
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new ZerionApiError('Zerion API returned non-JSON response', {
      status: response.status,
      url: response.url,
      body: text.slice(0, MAX_ERROR_BODY_BYTES),
      cause: err,
    })
  }
}

async function readText(response, signal) {
  // Pull the body in one shot when no streaming reader is available;
  // otherwise stream so the abort signal halts a hung connection promptly.
  const reader = response.body?.getReader?.()
  if (!reader) {
    return response.text()
  }
  const decoder = new TextDecoder()
  let out = ''
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {})
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      }
      const { done, value } = await reader.read()
      if (done) break
      if (value) out += decoder.decode(value, { stream: true })
    }
    out += decoder.decode()
  } finally {
    try { reader.releaseLock() } catch { /* noop */ }
  }
  return out
}

async function safeText(response, signal, maxBytes) {
  try {
    const text = await readText(response, signal)
    if (typeof maxBytes === 'number' && text.length > maxBytes) {
      return text.slice(0, maxBytes) + `…[truncated ${text.length - maxBytes} chars]`
    }
    return text
  } catch {
    return ''
  }
}

function parseRetryAfter(header) {
  if (!header) return null
  // RFC 7231: either a delta-seconds integer or an HTTP-date.
  const asInt = Number(header)
  if (Number.isFinite(asInt) && asInt >= 0) return Math.floor(asInt)
  const asDate = Date.parse(header)
  if (Number.isFinite(asDate)) {
    return Math.max(0, Math.ceil((asDate - Date.now()) / 1000))
  }
  return null
}

function extractNextCursor(nextLink, baseUrl) {
  if (!nextLink || typeof nextLink !== 'string') return null
  try {
    const u = new URL(nextLink, baseUrl)
    return u.searchParams.get('page[after]')
  } catch {
    return null
  }
}

function parseQuantity(qty) {
  // Precision-preserving: prefer the string `numeric` field. The numeric
  // `float` field will silently lose precision past ~15 significant digits,
  // which matters for tokens with 18 decimals (and for stablecoins
  // specifically, where every cent is observable on-chain).
  if (qty == null || typeof qty !== 'object') return '0'
  if (typeof qty.numeric === 'string' && qty.numeric.length > 0) return qty.numeric
  if (typeof qty.numeric === 'number' && Number.isFinite(qty.numeric)) return String(qty.numeric)
  if (typeof qty.float === 'number' && Number.isFinite(qty.float)) return String(qty.float)
  return '0'
}

function parsePositionResource(resource) {
  const attrs = resource?.attributes ?? {}
  const fungible = isPlainObject(attrs.fungible_info) ? attrs.fungible_info : {}
  const implementations = Array.isArray(fungible.implementations) ? fungible.implementations : []
  const chainRel = resource?.relationships?.chain?.data?.id ?? null
  // Only trust the matched implementation when the chain id actually matches.
  // Falling back to implementations[0] returns a contract address for the
  // wrong chain, which would silently route txns to the wrong asset.
  const matchedImpl = implementations.find((impl) => impl?.chain_id === chainRel) ?? null
  return {
    id: resource?.id ?? '',
    type: attrs.position_type ?? 'wallet',
    protocol: attrs.protocol ?? null,
    chain: chainRel ?? '',
    symbol: fungible.symbol ?? '',
    name: fungible.name ?? '',
    contractAddress: matchedImpl?.address ?? null,
    quantity: parseQuantity(attrs.quantity),
    valueUsd: numberOr(attrs.value, 0),
    priceUsd: numberOr(attrs.price, 0),
    change24hPercent: numberOr(attrs.changes?.percent_1d, 0),
  }
}

function parseTransactionResource(resource, address) {
  const attrs = resource?.attributes ?? {}
  const transferList = Array.isArray(attrs.transfers) ? attrs.transfers : []
  const transfers = transferList
    .map((t) => parseTransfer(t, address))
    .filter((t) => t !== null)
  return {
    hash: attrs.hash ?? resource?.id ?? '',
    chain: resource?.relationships?.chain?.data?.id ?? '',
    type: attrs.operation_type ?? 'execute',
    protocol: attrs.application_metadata?.name ?? null,
    timestamp: attrs.mined_at ? new Date(attrs.mined_at).getTime() : Date.now(),
    status: attrs.status ?? 'confirmed',
    transfers,
    feeUsd: numberOr(attrs.fee?.value, 0),
  }
}

function parseTransfer(transfer, address) {
  if (!transfer) return null
  // Preserve the third 'self' state — a transfer where the queried address
  // is both sender and recipient (e.g. moving between own subaccounts).
  // Coercing this to 'out' silently double-counts on cost-basis math.
  const rawDir = transfer.direction
  const direction = rawDir === 'in' || rawDir === 'out' || rawDir === 'self' ? rawDir : 'out'
  const fungible = isPlainObject(transfer.fungible_info) ? transfer.fungible_info : {}
  return {
    direction,
    symbol: fungible.symbol ?? '',
    quantity: parseQuantity(transfer.quantity),
    valueUsd: numberOr(transfer.value, 0),
    fromAddress: transfer.sender ?? '',
    toAddress: transfer.recipient ?? address ?? '',
  }
}

function parseNftResource(resource) {
  const attrs = resource?.attributes ?? {}
  const nftInfo = isPlainObject(attrs.nft_info) ? attrs.nft_info : {}
  const collection = isPlainObject(attrs.collection_info) ? attrs.collection_info : {}
  const content = isPlainObject(nftInfo.content) ? nftInfo.content : {}
  const chainRel = resource?.relationships?.chain?.data?.id ?? ''
  return {
    chain: chainRel,
    contractAddress: nftInfo.contract_address ?? '',
    tokenId: nftInfo.token_id ?? '',
    name: nftInfo.name ?? '',
    collectionName: collection.name ?? '',
    imageUrl: content.preview?.url ?? content.detail?.url ?? '',
    floorPriceUsd: collection.floor_price != null ? numberOr(collection.floor_price, null) : null,
    lastPriceUsd: attrs.last_price?.value != null ? numberOr(attrs.last_price.value, null) : null,
  }
}
