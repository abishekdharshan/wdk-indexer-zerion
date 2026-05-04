/**
 * Demo: WDK wallet + Zerion indexer.
 *
 * Derives an EVM account from a BIP-39 seed phrase using the Tether WDK,
 * then queries Zerion for the full multi-chain portfolio, positions,
 * recent interpreted transactions, and PnL — none of which WDK exposes
 * on its own today.
 *
 * Usage:
 *   ZERION_API_KEY=zk_dev_xxx \
 *   WALLET_ADDRESS=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 \
 *     node examples/portfolio-demo.js
 *
 * Optionally derive from a seed phrase instead of supplying WALLET_ADDRESS:
 *   ZERION_API_KEY=zk_dev_xxx \
 *   SEED_PHRASE='abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' \
 *     node examples/portfolio-demo.js
 *
 * SEED_PHRASE mode requires `@tetherto/wdk-wallet-evm` to be installed
 * alongside this package. WALLET_ADDRESS mode has no WDK runtime
 * dependency and is the simplest way to verify the indexer works.
 */

import { ZerionIndexerClient } from '../src/index.js'

async function main() {
  const apiKey = process.env.ZERION_API_KEY
  if (!apiKey) {
    console.error('Set ZERION_API_KEY (e.g. zk_dev_...) before running.')
    process.exit(1)
  }

  const address = await resolveAddress()
  console.log(`\nWatching ${address}\n`)

  const indexer = new ZerionIndexerClient({ apiKey })

  // 1. Multi-chain portfolio rollup — one call.
  const portfolio = await indexer.getPortfolio(address)
  printSection('Portfolio')
  console.log(`  Total value: ${formatSignedUsd(portfolio.totalValue)}`)
  console.log(
    `  24h change:  ${portfolio.change24hPercent >= 0 ? '+' : ''}${portfolio.change24hPercent.toFixed(2)}%  ` +
      `(${formatSignedUsd(portfolio.change24hAbsolute)})`,
  )
  console.log(`  Wallet:      ${formatSignedUsd(portfolio.walletValue)}`)
  console.log(`  Deposited:   ${formatSignedUsd(portfolio.depositedValue)}`)
  console.log(`  Staked:      ${formatSignedUsd(portfolio.stakedValue)}`)
  console.log(`  Borrowed:    ${formatSignedUsd(portfolio.borrowedValue)}`)
  if (portfolio.byChain.length > 0) {
    console.log('  By chain:')
    for (const { chain, value } of portfolio.byChain
      .filter((c) => c.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)) {
      console.log(`    ${chain.padEnd(14)} ${formatSignedUsd(value)}`)
    }
  }

  // 2. Decoded positions including DeFi.
  const { positions } = await indexer.getPositions(address)
  printSection('Top 10 positions (by USD value)')
  for (const p of positions
    .filter((p) => p.valueUsd > 0)
    .sort((a, b) => b.valueUsd - a.valueUsd)
    .slice(0, 10)) {
    const protocolLabel = p.protocol ? ` via ${p.protocol}` : ''
    console.log(
      `  ${p.symbol.padEnd(10)} ${p.type.padEnd(10)}${protocolLabel.padEnd(22)}  ` +
        `qty=${p.quantity}  ${formatSignedUsd(p.valueUsd)}`,
    )
  }

  // 3. Interpreted recent transactions.
  const { transactions } = await indexer.getTransactions(address, { limit: 10 })
  printSection('Last 10 transactions (interpreted)')
  for (const tx of transactions) {
    const protocolLabel = tx.protocol ? ` on ${tx.protocol}` : ''
    const flow =
      tx.transfers
        .map((t) => {
          const sign = t.direction === 'in' ? '+' : t.direction === 'self' ? '~' : '-'
          return `${sign}${t.quantity} ${t.symbol}`
        })
        .join(', ') || '(no token transfers)'
    console.log(
      `  ${new Date(tx.timestamp).toISOString().slice(0, 16).replace('T', ' ')}  ` +
        `${tx.type.padEnd(10)}${protocolLabel.padEnd(22)}  ${flow}`,
    )
  }

  // 4. PnL.
  printSection('PnL')
  try {
    const pnl = await indexer.getPnl(address)
    console.log(`  Realized:     ${formatSignedUsd(pnl.realizedPnlUsd)}`)
    console.log(`  Unrealized:   ${formatSignedUsd(pnl.unrealizedPnlUsd)}`)
    console.log(`  Total PnL:    ${formatSignedUsd(pnl.totalPnlUsd)}`)
    console.log(`  Net invested: ${formatSignedUsd(pnl.netInvestedUsd)}`)
    console.log(`  Fees paid:    ${formatSignedUsd(pnl.totalFeesUsd)}`)
  } catch (err) {
    console.log(`  PnL unavailable (${err.message})`)
  }

  console.log('\nDone.\n')
}

async function resolveAddress() {
  const explicit = process.env.WALLET_ADDRESS?.trim()
  if (explicit) return explicit

  const seedRaw = process.env.SEED_PHRASE
  if (!seedRaw) {
    throw new Error('Set WALLET_ADDRESS or SEED_PHRASE before running.')
  }
  // BIP-39 word list normalization: collapse whitespace and trim ends so a
  // copy-pasted seed (often padded with newlines) works first try.
  const seed = seedRaw.trim().replace(/\s+/g, ' ')
  if (seed.length === 0) {
    throw new Error('SEED_PHRASE is empty.')
  }

  // Lazy-load WDK only if a seed is supplied — keeps the demo runnable
  // without WDK installed when watching an existing address.
  let WalletManagerEvm
  try {
    ;({ default: WalletManagerEvm } = await import('@tetherto/wdk-wallet-evm'))
  } catch (err) {
    // Only swallow the "module not found" case. Anything else (syntax error
    // in the installed package, transitive import failure, etc.) should
    // surface, not be hidden behind the install hint.
    if (err?.code !== 'ERR_MODULE_NOT_FOUND' && err?.code !== 'MODULE_NOT_FOUND') {
      throw err
    }
    throw new Error(
      'SEED_PHRASE mode requires `@tetherto/wdk-wallet-evm`. ' +
        'Install it (npm i @tetherto/wdk-wallet-evm) or pass WALLET_ADDRESS instead.',
    )
  }

  let wallet
  try {
    wallet = new WalletManagerEvm(seed, {
      provider: process.env.RPC_URL || 'https://eth.llamarpc.com',
    })
    const account = await wallet.getAccount(0)
    return await account.getAddress()
  } finally {
    // Always dispose, even if account derivation throws — otherwise the
    // wallet's internal RPC client / keystore can keep the process alive.
    try { wallet?.dispose?.() } catch { /* noop */ }
  }
}

function printSection(label) {
  console.log(`\n— ${label} —`)
}

function formatSignedUsd(n) {
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${sign}$${abs.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  return `${sign}$${abs.toFixed(2)}`
}

main().catch((err) => {
  console.error('\nDemo failed:', err.message)
  if (err.body) console.error('Server body:', err.body.slice(0, 500))
  process.exit(1)
})
