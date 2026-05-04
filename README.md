# @zerion/wdk-indexer-zerion

> Zerion-powered indexer for the Tether Wallet Development Kit.

A drop-in `WalletIndexerClient` for [WDK](https://github.com/tetherto/wdk) that adds **interpreted multi-chain portfolio, positions, transactions, NFTs, and PnL** to any WDK wallet account. It mirrors the abstract-client pattern WDK already uses for prices ([`@tetherto/wdk-pricing-provider`](https://github.com/tetherto/wdk-pricing-provider)) so it slots in cleanly alongside existing modules.

| Capability today (WDK alone) | With this module |
|---|---|
| `account.getBalance()` — native via RPC | `indexer.getPortfolio(addr)` — total USD across every chain |
| `account.getTokenBalance(contract)` — one ERC-20 at a time | `indexer.getPositions(addr)` — every token, every DeFi position, decoded by protocol |
| (none) | `indexer.getTransactions(addr)` — interpreted history ("trade on Uniswap V3", not raw bytes) |
| (none) | `indexer.getNfts(addr)` — NFTs with floor + last-sale prices |
| (none) | `indexer.getPnl(addr)` — realized + unrealized |

Works with read-only / watch-only WDK accounts (`WalletAccountReadOnlyEvm`, etc.) — no private key required to query state.

---

## Why this exists

WDK is excellent at the wallet primitives — derive, sign, send, estimate — but it deliberately stays thin on reads. Today every chain wallet calls RPC for a single native balance or single ERC-20 balance, and there is no surface for cross-chain rollups, DeFi position decoding, or transaction interpretation.

[Zerion](https://developers.zerion.io) already does that work in production at scale for clients including Coinbase Wallet, Uniswap, Rainbow, Revolut, Kraken, and Safe. "Interpreted" means each transaction is decoded into a human-readable action (e.g. _"Swap 1.2 ETH for 4,200 USDC on Uniswap V3"_) instead of raw calldata, and each position is enriched with protocol context (_"USDC deposited in Aave V3"_), USD value, and 24h change.

This module exposes that data through a clean `WalletIndexerClient` interface that any vendor can implement, with Zerion as the first concrete client.

The `WalletIndexerClient` abstract base in [`src/indexer-client.js`](src/indexer-client.js) is intentionally upstreamable — a PR sibling to `WalletManager` / `WalletAccount` in `@tetherto/wdk-wallet`.

---

## Install

```bash
npm install @zerion/wdk-indexer-zerion
```

You'll need a Zerion API key: <https://developers.zerion.io>. The free dev tier is 120 req/min.

---

## Quick start

### Watch any address (no seed required)

```js
import { ZerionIndexerClient } from '@zerion/wdk-indexer-zerion'

const indexer = new ZerionIndexerClient({ apiKey: process.env.ZERION_API_KEY })

const portfolio = await indexer.getPortfolio('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
console.log(`Total: $${portfolio.totalValue}, +${portfolio.change24hPercent}% in 24h`)

const { positions } = await indexer.getPositions(portfolio.address)
console.log(positions.filter((p) => p.protocol).slice(0, 5))   // top 5 DeFi positions
```

### Compose with a WDK wallet

```js
import WDK from '@tetherto/wdk'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import { ZerionIndexerClient } from '@zerion/wdk-indexer-zerion'

const wdk = new WDK(process.env.SEED_PHRASE).registerWallet('evm', WalletManagerEvm, {
  provider: 'https://eth.llamarpc.com',
})
const account = await wdk.getAccount('evm', 0)
const address = await account.getAddress()

const indexer = new ZerionIndexerClient({ apiKey: process.env.ZERION_API_KEY })
const { transactions } = await indexer.getTransactions(address, { limit: 20 })

for (const tx of transactions) {
  const protocol = tx.protocol ? ` on ${tx.protocol}` : ''
  console.log(`${tx.type}${protocol}: $${tx.transfers.reduce((s, t) => s + t.valueUsd, 0)}`)
}
```

### Run the demo

```bash
ZERION_API_KEY=zk_dev_xxx \
WALLET_ADDRESS=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 \
  node examples/portfolio-demo.js
```

---

## API

### `new ZerionIndexerClient(options)`

| Option | Type | Default | Notes |
|---|---|---|---|
| `apiKey` | `string` | — | Required. `zk_dev_*` or `zk_prod_*` |
| `baseUrl` | `string` | `https://api.zerion.io` | Override for staging |
| `environment` | `'production' \| 'testnet'` | `'production'` | Maps to `X-Env` header |
| `currency` | `string` | `'usd'` | Settlement currency |
| `timeoutMs` | `number` | `15000` | Per-request timeout |
| `fetch` | `typeof fetch` | `globalThis.fetch` | Inject for tests |

### Methods

| Method | Returns |
|---|---|
| `getPortfolio(address)` | `PortfolioSummary` — total + by-chain + 24h change |
| `getPositions(address, { chains?, positionTypes? })` | `{ positions: TokenPosition[] }` |
| `getTransactions(address, { limit?, chains?, cursor? })` | `{ transactions: InterpretedTransaction[], nextCursor }` |
| `getNfts(address, { chains?, limit?, cursor? })` | `{ nfts: NftPosition[], nextCursor }` |
| `getPnl(address)` | `PnlSummary` |

Full TypeScript-grade JSDoc in [`src/indexer-client.js`](src/indexer-client.js).

### Error handling

All HTTP failures throw `ZerionApiError` with `status`, `url`, and the response body when available. Network/timeout failures surface as `status: 0`.

---

## Chain coverage

EVM mainnets and major L2s (Ethereum, Arbitrum, Optimism, Base, Polygon, Avalanche, Linea, Scroll, Mantle, Blast, zkSync Era, …) and Solana. Coverage extends to the long tail of EVM chains Zerion supports — see <https://developers.zerion.io> for the current list. Pass `chains: ['ethereum', 'arbitrum']` to scope results.

Bitcoin, Tron, TON, and Spark — chains that WDK supports as wallet modules — are not covered by this client. Future indexer clients in this ecosystem (e.g. an Alchemy or Covalent implementation of `WalletIndexerClient`) can fill those gaps.

---

## Roadmap

This first cut intentionally ships only the abstract base + a thin Zerion client. Planned follow-ups:

- `IndexerProvider` cache wrapper to mirror `PricingProvider`, with TTL cache and in-flight request deduplication so concurrent calls for the same address share a single network round-trip.
- Webhook-style streaming via Zerion's Kafka feed.
- Direct WDK PR adding `WalletIndexerClient` as a base class in `@tetherto/wdk-wallet`, alongside `PricingClient`.

---

## License

Apache 2.0 — matches the rest of the WDK ecosystem.

## Contact

- Zerion API docs: <https://developers.zerion.io>
- Issues: <https://github.com/zeriontech/wdk-indexer-zerion/issues>
- Partnerships: api@zerion.io
