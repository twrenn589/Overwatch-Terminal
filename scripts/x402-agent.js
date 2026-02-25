#!/usr/bin/env node
'use strict';

/**
 * Overwatch Terminal — x402 Testnet Agent
 *
 * Demonstrates autonomous AI agent micropayments on XRPL testnet.
 * Creates/loads a testnet wallet, funds via faucet if needed, sends a
 * demo "data purchase" micropayment, and writes results to dashboard-data.json
 * under the x402_agent key.
 *
 * Run: node scripts/x402-agent.js
 */

const path      = require('path');
const fs        = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const xrpl      = require('xrpl');
const simpleGit = require('simple-git');

// ─── Config ────────────────────────────────────────────────────────────────

const WALLET_FILE  = path.join(__dirname, 'x402-wallet.json');
const DATA_FILE    = path.join(__dirname, '..', 'dashboard-data.json');
const REPO_ROOT    = path.join(__dirname, '..');

const TESTNET_WS   = 'wss://s.altnet.rippletest.net:51233';
const FAUCET_URL   = 'https://faucet.altnet.rippletest.net/accounts';

// Refund agent wallet if balance drops below this (XRP)
const MIN_BALANCE  = 50;
// XRP amount per demo micropayment
const DEMO_AMOUNT  = '1';

// ─── Logging ───────────────────────────────────────────────────────────────

function log(msg)  { console.log(`[x402-agent] ${msg}`); }
function warn(msg) { console.warn(`[x402-agent] WARN: ${msg}`); }
function err(msg)  { console.error(`[x402-agent] ERROR: ${msg}`); }

// ─── Wallet persistence ────────────────────────────────────────────────────

function loadWallets() {
  try {
    if (fs.existsSync(WALLET_FILE)) {
      const raw = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
      if (raw?.agent?.seed && raw?.provider?.seed) return raw;
    }
  } catch (e) {
    warn(`Cannot read wallet file: ${e.message}`);
  }
  return null;
}

function saveWallets(data) {
  fs.writeFileSync(WALLET_FILE, JSON.stringify(data, null, 2));
  log(`Wallet state saved to ${WALLET_FILE}`);
}

// ─── Faucet ────────────────────────────────────────────────────────────────

async function callFaucet(address) {
  log(`Requesting testnet XRP for ${address}...`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const res = await fetch(FAUCET_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ destination: address, xrpAmount: '1000' }),
      signal:  controller.signal,
    });
    if (!res.ok) throw new Error(`Faucet HTTP ${res.status}: ${res.statusText}`);
    const data = await res.json();
    log(`Faucet response: balance=${data.balance}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Balance helpers ────────────────────────────────────────────────────────

async function getBalanceSafe(client, address) {
  try {
    const bal = await client.getXrpBalance(address);
    return parseFloat(bal) || 0;
  } catch (e) {
    // Account may not exist on testnet yet (not funded)
    if (e.message?.includes('Account not found') || e.data?.error === 'actNotFound') {
      return 0;
    }
    throw e;
  }
}

/**
 * Ensure an address has at least MIN_BALANCE XRP.
 * Calls the testnet faucet and waits for confirmation if underfunded.
 * Returns the final balance.
 */
async function ensureFunded(client, address, label) {
  const bal = await getBalanceSafe(client, address);
  if (bal >= MIN_BALANCE) {
    log(`${label} (${address.slice(0, 8)}…) balance: ${bal} XRP — ok`);
    return bal;
  }
  log(`${label} balance: ${bal} XRP — below ${MIN_BALANCE}, calling faucet...`);
  await callFaucet(address);
  log('Waiting 12s for faucet transaction to confirm...');
  await new Promise(r => setTimeout(r, 12_000));
  const newBal = await getBalanceSafe(client, address);
  log(`${label} new balance: ${newBal} XRP`);
  return newBal;
}

// ─── Git push helper ───────────────────────────────────────────────────────

async function pushFiles(files, message) {
  const git    = simpleGit(REPO_ROOT);
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    warn('Not a git repo — skipping push');
    return;
  }
  try {
    for (const f of files) await git.add(f);
    const status = await git.status();
    if (status.staged.length === 0) {
      log('Nothing to commit — all files unchanged');
      return;
    }
    await git.commit(message);
    await git.push('origin', 'main');
    log(`Pushed: "${message}"`);
  } catch (e) {
    err(`Git push failed: ${e.message}`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n━━━ Overwatch x402 Testnet Agent ━━━');
  console.log(`Started: ${new Date().toISOString()}\n`);

  // Load or generate wallet state
  let walletState = loadWallets();
  let isFirstRun  = false;

  if (!walletState) {
    log('No wallet state found — generating new testnet wallets...');
    isFirstRun = true;

    const agentWallet    = xrpl.Wallet.generate();
    const providerWallet = xrpl.Wallet.generate();

    walletState = {
      _note:      'TESTNET ONLY — these seeds have no real-world value',
      network:    'XRPL TESTNET',
      created_at: new Date().toISOString(),
      agent: {
        seed:    agentWallet.seed,
        address: agentWallet.address,
        label:   'Overwatch Analyst Agent',
      },
      provider: {
        seed:    providerWallet.seed,
        address: providerWallet.address,
        label:   'Premium Data Service (DEMO)',
      },
    };

    saveWallets(walletState);
    log(`Agent address:    ${walletState.agent.address}`);
    log(`Provider address: ${walletState.provider.address}`);
  } else {
    log(`Loaded existing wallets — agent: ${walletState.agent.address}`);
  }

  const agentWallet    = xrpl.Wallet.fromSeed(walletState.agent.seed);
  const providerWallet = xrpl.Wallet.fromSeed(walletState.provider.seed);

  // Connect to testnet
  const client = new xrpl.Client(TESTNET_WS);
  await client.connect();
  log(`Connected to XRPL testnet: ${TESTNET_WS}`);

  // Fund wallets if below threshold (handles testnet resets automatically)
  const agentBal = await ensureFunded(client, agentWallet.address, 'Agent');
  await ensureFunded(client, providerWallet.address, 'Provider');

  // Load existing x402_agent data (for payment counter continuity)
  let existingAgentData = null;
  try {
    const dash = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    existingAgentData = dash?.x402_agent;
  } catch (e) {
    warn(`Could not read dashboard-data.json: ${e.message}`);
  }
  const prevPaymentCount = existingAgentData?.demo_payments_sent ?? 0;

  // Make demo micropayment: agent → provider (x402 pattern)
  let lastPayment  = existingAgentData?.last_payment ?? null;
  let paymentCount = prevPaymentCount;

  if (agentBal >= 10) {
    try {
      log(`Sending ${DEMO_AMOUNT} XRP micropayment: agent → provider...`);

      // Encode x402 memo fields as hex (XRPL memo requirement)
      const memoData = Buffer.from(
        'x402:premium_data_access:overwatch-terminal', 'utf8'
      ).toString('hex').toUpperCase();
      const memoType = Buffer.from('text/plain', 'utf8')
        .toString('hex').toUpperCase();

      const result = await client.submitAndWait(
        {
          TransactionType: 'Payment',
          Account:         agentWallet.address,
          Destination:     providerWallet.address,
          Amount:          xrpl.xrpToDrops(DEMO_AMOUNT),
          Memos: [{ Memo: { MemoData: memoData, MemoType: memoType } }],
        },
        { autofill: true, wallet: agentWallet }
      );

      const txResult = result.result.meta?.TransactionResult;
      log(`Payment result: ${txResult} | hash: ${result.result.hash}`);

      if (txResult === 'tesSUCCESS') {
        paymentCount = prevPaymentCount + 1;
        lastPayment  = {
          to:           providerWallet.address,
          to_label:     walletState.provider.label,
          amount_xrp:   parseFloat(DEMO_AMOUNT),
          memo:         'x402:premium_data_access:overwatch-terminal',
          tx_hash:      result.result.hash,
          ledger_index: result.result.ledger_index,
          timestamp:    new Date().toISOString(),
          status:       'SUCCESS',
        };
      }
    } catch (e) {
      err(`Demo payment failed: ${e.message}`);
    }
  } else {
    warn(`Agent balance ${agentBal} XRP — skipping demo payment (need ≥10 XRP)`);
  }

  // Re-check agent balance after payment
  const finalBal = await getBalanceSafe(client, agentWallet.address);

  // Fetch recent tx history for agent wallet
  let txHistory = [];
  try {
    const txRes = await client.request({
      command:          'account_tx',
      account:          agentWallet.address,
      ledger_index_min: -1,
      ledger_index_max: -1,
      limit:            10,
      forward:          false,
    });

    txHistory = (txRes.result.transactions ?? []).slice(0, 10).map(({ tx, meta }) => {
      const amountDrops = tx.Amount && typeof tx.Amount === 'string' ? tx.Amount : null;
      return {
        type:         tx.TransactionType,
        hash:         tx.hash,
        amount_xrp:   amountDrops ? parseFloat(xrpl.dropsToXrp(amountDrops)) : null,
        direction:    tx.Account === agentWallet.address ? 'out' : 'in',
        counterparty: tx.Account === agentWallet.address
          ? (tx.Destination ?? null)
          : tx.Account,
        result:       meta?.TransactionResult ?? null,
        // XRPL epoch: seconds since 2000-01-01 → Unix milliseconds
        date: tx.date ? new Date((tx.date + 946684800) * 1000).toISOString() : null,
      };
    });

    log(`Fetched ${txHistory.length} transactions from history`);
  } catch (e) {
    warn(`Could not fetch tx history: ${e.message}`);
  }

  await client.disconnect();
  log('Disconnected from XRPL testnet');

  // Build x402_agent output block
  const x402Agent = {
    network:            'XRPL TESTNET',
    network_warning:    '⚠ TESTNET ONLY — Not real XRP',
    agent_address:      agentWallet.address,
    agent_label:        walletState.agent.label,
    provider_address:   providerWallet.address,
    provider_label:     walletState.provider.label,
    balance_xrp:        parseFloat(finalBal.toFixed(6)),
    demo_payments_sent: paymentCount,
    last_payment:       lastPayment,
    tx_history:         txHistory,
    demo_scenario:      'Overwatch analyst agent auto-pays for premium data feeds using x402 micropayments on XRPL testnet',
    last_updated:       new Date().toISOString(),
  };

  // Merge into dashboard-data.json (preserve all other keys)
  const dashData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  dashData.x402_agent = x402Agent;
  fs.writeFileSync(DATA_FILE, JSON.stringify(dashData, null, 2));
  log('Wrote x402_agent block to dashboard-data.json');

  // Push to GitHub
  const filesToPush = ['dashboard-data.json'];
  if (isFirstRun) filesToPush.push('scripts/x402-wallet.json');

  const stamp = new Date().toISOString().replace('T', ' ').substring(0, 16) + ' UTC';
  await pushFiles(filesToPush, `auto: x402 agent update ${stamp}`);

  // Summary
  console.log('\n─── x402 Agent Summary ─────────────────────────');
  console.log(`Agent address:   ${agentWallet.address}`);
  console.log(`Provider address:${providerWallet.address}`);
  console.log(`Balance:         ${finalBal} XRP`);
  console.log(`Payments sent:   ${paymentCount}`);
  console.log(`Last tx hash:    ${lastPayment?.tx_hash ?? 'none'}`);
  console.log('─────────────────────────────────────────────────\n');
}

main().catch(e => {
  err(e.message);
  process.exit(1);
});
