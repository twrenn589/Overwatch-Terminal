#!/usr/bin/env node
'use strict';

/**
 * Overwatch Terminal — Automated Data Ingestion
 * Fetches live data from free APIs, merges with existing JSON, and writes
 * dashboard-data.json. Run `node scripts/fetch-data.js` or via cron.
 */

const path    = require('path');
const fs      = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { ENDPOINTS, COINGECKO_DELAY_MS, KILL_SWITCH_TARGETS } = require('./config');
const { fetchXIntelligence } = require('./fetch-x');
const pushToGitHub = require('./push-to-github');

const OUTPUT_PATH = path.join(__dirname, '..', 'dashboard-data.json');

// ─── Utilities ────────────────────────────────────────────────────────────────

function log(label, msg)  { console.log(`[${label}] ${msg}`); }
function warn(label, msg) { console.warn(`[${label}] WARN: ${msg}`); }
function err(label, msg)  { console.error(`[${label}] ERROR: ${msg}`); }

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Load existing dashboard-data.json so we can fall back to previous values. */
function loadExisting() {
  try {
    if (fs.existsSync(OUTPUT_PATH)) {
      return JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
    }
  } catch (e) {
    warn('io', `Could not read existing dashboard-data.json: ${e.message}`);
  }
  return {};
}

/**
 * Thin fetch wrapper with timeout.
 * Returns parsed JSON or throws.
 */
async function fetchJSON(url, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ─── Individual fetchers ──────────────────────────────────────────────────────

async function fetchXRP(fallback) {
  const fetchedAt = new Date().toISOString().slice(0, 10);
  try {
    const data = await fetchJSON(ENDPOINTS.xrp);
    const r = data?.ripple;
    if (!r) throw new Error('Unexpected response shape');
    const result = {
      price:      r.usd              ?? null,
      change_24h: r.usd_24h_change   ?? null,
      volume_24h: r.usd_24h_vol      ?? null,
      market_cap: r.usd_market_cap   ?? null,
      data_date:  fetchedAt,
      source:     'coingecko',
    };
    log('XRP', `price=${result.price}  24h=${result.change_24h?.toFixed(2)}%`);
    return result;
  } catch (e) {
    err('XRP', e.message);
    return fallback?.xrp ?? { price: null, change_24h: null, volume_24h: null, market_cap: null, data_date: null, source: 'coingecko' };
  }
}

async function fetchRLUSD(fallback) {
  const fetchedAt = new Date().toISOString().slice(0, 10);
  await sleep(COINGECKO_DELAY_MS);
  try {
    const data = await fetchJSON(ENDPOINTS.rlusd);
    const r = data?.['ripple-usd'];
    if (!r) throw new Error('Unexpected response shape — will try search');
    const result = { market_cap: r.usd_market_cap ?? null, data_date: fetchedAt, source: 'coingecko' };
    log('RLUSD', `market_cap=${result.market_cap?.toLocaleString()}`);
    return result;
  } catch (e) {
    warn('RLUSD', `Primary ID failed (${e.message}), trying search…`);
    try {
      await sleep(COINGECKO_DELAY_MS);
      const search = await fetchJSON(ENDPOINTS.rlusd_search);
      const coin = search?.coins?.find(c => c.symbol?.toUpperCase() === 'RLUSD');
      if (!coin) throw new Error('RLUSD not found in search results');
      await sleep(COINGECKO_DELAY_MS);
      const data2 = await fetchJSON(
        `https://api.coingecko.com/api/v3/simple/price?ids=${coin.id}&vs_currencies=usd&include_market_cap=true`
      );
      const r2 = data2?.[coin.id];
      const result = { market_cap: r2?.usd_market_cap ?? null, data_date: fetchedAt, source: 'coingecko' };
      log('RLUSD', `market_cap=${result.market_cap?.toLocaleString()} (via search id=${coin.id})`);
      return result;
    } catch (e2) {
      err('RLUSD', e2.message);
      return fallback?.rlusd ?? { market_cap: null, data_date: null, source: 'manual' };
    }
  }
}

async function fetchFearGreed(fallback) {
  try {
    const data = await fetchJSON(ENDPOINTS.fear_greed);
    const entry = data?.data?.[0];
    if (!entry) throw new Error('Unexpected response shape');
    const dataDate = entry.timestamp
      ? new Date(Number(entry.timestamp) * 1000).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const result = {
      value:     Number(entry.value),
      label:     entry.value_classification,
      data_date: dataDate,
      source:    'alternative.me',
    };
    log('Fear&Greed', `${result.value} — ${result.label} (date: ${dataDate})`);
    return result;
  } catch (e) {
    err('Fear&Greed', e.message);
    return fallback?.macro?.fear_greed ?? { value: null, label: null, data_date: null, source: 'alternative.me' };
  }
}

async function fetchUSDJPY(fallback) {
  const fetchedAt = new Date().toISOString().slice(0, 10);
  try {
    const data = await fetchJSON(ENDPOINTS.usd_jpy);
    const rate = data?.rates?.JPY;
    if (!rate) throw new Error('Unexpected response shape');
    const dataDate = data?.date || fetchedAt;
    log('USD/JPY', `${rate} (date: ${dataDate})`);
    return { value: rate, data_date: dataDate, source: 'frankfurter' };
  } catch (e) {
    err('USD/JPY', e.message);
    return fallback?.macro?.usd_jpy ?? { value: null, data_date: null, source: 'frankfurter' };
  }
}

async function fetchFRED(seriesLabel, url, fallbackValue) {
  const key = process.env.FRED_API_KEY;
  if (!key) {
    warn('FRED', `FRED_API_KEY not set — skipping ${seriesLabel}`);
    return fallbackValue ?? { value: null, data_date: null, source: 'fred' };
  }
  try {
    const fullUrl = `${url}&api_key=${encodeURIComponent(key)}`;
    const data = await fetchJSON(fullUrl);
    const obs = data?.observations?.find(o => o.value !== '.' && o.value !== '');
    if (!obs) throw new Error('No valid observation in response');
    const value = parseFloat(obs.value);
    const dataDate = obs.date || null;
    log('FRED', `${seriesLabel} = ${value} (date: ${dataDate})`);
    return { value, data_date: dataDate, source: 'fred' };
  } catch (e) {
    err('FRED', `${seriesLabel}: ${e.message}`);
    return fallbackValue ?? { value: null, data_date: null, source: 'fred' };
  }
}

// ─── Stooq fetcher (CSV) ──────────────────────────────────────────────────────

async function fetchStooq(label, url, fallbackValue) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const lines = text.trim().split('\n');
    if (lines.length < 2) throw new Error('No data rows in CSV');
    const values = lines[1].split(',');
    const close = parseFloat(values[6]);
    if (isNaN(close)) throw new Error('Could not parse close price');
    const dataDate = values[1] || null;
    log('Stooq', `${label} = ${close} (date: ${dataDate})`);
    return { value: close, data_date: dataDate, source: 'stooq' };
  } catch (e) {
    err('Stooq', `${label}: ${e.message}`);
    return fallbackValue ?? { value: null, data_date: null, source: 'stooq' };
  }
}

// ─── Twelve Data fetcher ──────────────────────────────────────────────────────

async function fetchTwelveData(label, url, fallbackValue) {
  const key = process.env.TWELVE_DATA_KEY;
  if (!key) {
    warn('TwelveData', `TWELVE_DATA_KEY not set — skipping ${label}`);
    return fallbackValue ?? { value: null, data_date: null, source: 'twelve_data' };
  }
  try {
    const fullUrl = `${url}&apikey=${encodeURIComponent(key)}`;
    const data = await fetchJSON(fullUrl);
    if (data.status === 'error') throw new Error(data.message || 'API error');
    const value = parseFloat(data?.values?.[0]?.close);
    if (isNaN(value)) throw new Error('Could not parse close value');
    const dataDate = data?.values?.[0]?.datetime ?? null;
    log('TwelveData', `${label} = ${value} (date: ${dataDate})`);
    return { value, data_date: dataDate, source: 'twelve_data' };
  } catch (e) {
    err('TwelveData', `${label}: ${e.message}`);
    return fallbackValue ?? { value: null, data_date: null, source: 'twelve_data' };
  }
}

// ─── FinanceFlow fetcher ─────────────────────────────────────────────────────

async function fetchFinanceFlowBond(label, url, fallbackValue) {
  const key = process.env.FINANCEFLOW_API_KEY;
  if (!key) {
    warn('FinanceFlow', `FINANCEFLOW_API_KEY not set — skipping ${label}`);
    return fallbackValue ?? { value: null, data_date: null, source: 'financeflow' };
  }
  try {
    const fullUrl = `${url}&api_key=${encodeURIComponent(key)}`;
    const data = await fetchJSON(fullUrl);
    if (!data?.success || data?.code !== 200) throw new Error(data?.message || 'API error');
    const entry = data?.data?.[0];
    if (!entry) throw new Error('No bond data in response');
    const value = parseFloat(entry.bond_yield);
    if (isNaN(value)) throw new Error('Could not parse bond_yield');
    const dataDate = entry.last_updated ? entry.last_updated.split(' ')[0] : null;
    log('FinanceFlow', `${label} = ${value}% (date: ${dataDate})`);
    return { value, data_date: dataDate, source: 'financeflow' };
  } catch (e) {
    err('FinanceFlow', `${label}: ${e.message}`);
    return fallbackValue ?? { value: null, data_date: null, source: 'financeflow' };
  }
}

async function fetchFinanceFlowCommodity(label, url, fallbackValue) {
  const key = process.env.FINANCEFLOW_API_KEY;
  if (!key) {
    warn('FinanceFlow', `FINANCEFLOW_API_KEY not set — skipping ${label}`);
    return fallbackValue ?? { value: null, data_date: null, source: 'financeflow' };
  }
  try {
    const fullUrl = `${url}&api_key=${encodeURIComponent(key)}`;
    const data = await fetchJSON(fullUrl);
    if (!data?.success || data?.code !== 200) throw new Error(data?.message || 'API error');
    const entry = data?.data;
    if (!entry) throw new Error('No commodity data in response');
    const value = parseFloat(entry.current_price);
    if (isNaN(value)) throw new Error('Could not parse current_price');
    const dataDate = entry.last_updated ? entry.last_updated.split(' ')[0] : null;
    log('FinanceFlow', `${label} = ${value} (date: ${dataDate})`);
    return { value, data_date: dataDate, source: 'financeflow' };
  } catch (e) {
    err('FinanceFlow', `${label}: ${e.message}`);
    return fallbackValue ?? { value: null, data_date: null, source: 'financeflow' };
  }
}

async function fetchFinanceFlowCurrency(label, url, fallbackValue) {
  const key = process.env.FINANCEFLOW_API_KEY;
  if (!key) {
    warn('FinanceFlow', `FINANCEFLOW_API_KEY not set — skipping ${label}`);
    return fallbackValue ?? { value: null, data_date: null, source: 'financeflow' };
  }
  try {
    const fullUrl = `${url}&api_key=${encodeURIComponent(key)}`;
    const data = await fetchJSON(fullUrl);
    if (!data?.success || data?.code !== 200) throw new Error(data?.message || 'API error');
    const entry = data?.data?.[0];
    if (!entry) throw new Error('No currency data in response');
    const value = parseFloat(entry.price);
    if (isNaN(value)) throw new Error('Could not parse price');
    const dataDate = entry.last_update ? entry.last_update.split(' ')[0] : null;
    log('FinanceFlow', `${label} = ${value} (date: ${dataDate})`);
    return { value, data_date: dataDate, source: 'financeflow' };
  } catch (e) {
    err('FinanceFlow', `${label}: ${e.message}`);
    return fallbackValue ?? { value: null, data_date: null, source: 'financeflow' };
  }
}

// ─── XRPL fetcher (expanded) ────────────────────────────────────────────────
//
// Five calls to rippled JSON-RPC:
//   1. server_info       → ledger_index, base_fee_xrp, current_ledger
//   2. gateway_balances  → rlusd_supply
//   3. ledger            → last_ledger_txns, fee_burn_per_ledger_xrp
//   4. book_offers (asks) → order book ask side (XRP selling for USD)
//   5. book_offers (bids) → order book bid side (USD selling for XRP)
//
// NOT fetched (known gaps, documented in data-contract.json currently_null):
//   - dex_volume_24h_usd/xrp, dex_exchanges_24h, dex_takers_24h (need aggregator)
//   - avg_tx_per_ledger (needs multi-ledger sampling)

async function fetchXRPL(fallback) {
  const url = ENDPOINTS.xrpl.server_info;
  const issuer = ENDPOINTS.xrpl.rlusd_issuer;
  const fetchedAt = new Date().toISOString().slice(0, 10);
  const BITSTAMP_USD = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';

  const result = {
    // Existing fields (from server_info + gateway_balances)
    ledger_index: null,
    rlusd_supply: null,
    data_date: fetchedAt,
    source: 'xrpl',
    // New fields (from ledger + book_offers)
    current_ledger: null,
    last_ledger_txns: null,
    avg_tx_per_ledger: null,
    fee_burn_per_ledger_xrp: null,
    dex_volume_24h_usd: null,
    dex_volume_24h_xrp: null,
    dex_exchanges_24h: null,
    dex_takers_24h: null,
    book_depth_xrp_usd: null,
  };

  let baseFeeXrp = null;

  // ── Call 1: server_info — ledger index + base fee ──
  try {
    const controller1 = new AbortController();
    const timer1 = setTimeout(() => controller1.abort(), 15000);
    const r1 = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'server_info', params: [{}] }),
      signal: controller1.signal,
    });
    clearTimeout(timer1);
    const d1 = await r1.json();
    const vl = d1?.result?.info?.validated_ledger;
    if (vl?.seq) {
      result.ledger_index = vl.seq;
      result.current_ledger = vl.seq;
      baseFeeXrp = vl.base_fee_xrp ?? null;
      log('XRPL', `ledger_index = ${vl.seq}, base_fee = ${baseFeeXrp} XRP`);
    } else {
      warn('XRPL', 'No validated_ledger in server_info response');
    }
  } catch (e) {
    err('XRPL', `server_info: ${e.message}`);
  }

  // ── Call 2: gateway_balances — RLUSD supply ──
  try {
    const controller2 = new AbortController();
    const timer2 = setTimeout(() => controller2.abort(), 15000);
    const r2 = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'gateway_balances',
        params: [{ account: issuer, hotwallet: [], strict: true }],
      }),
      signal: controller2.signal,
    });
    clearTimeout(timer2);
    const d2 = await r2.json();
    const obligations = d2?.result?.obligations;
    if (obligations) {
      const rlusdKey = Object.keys(obligations).find(k => k.startsWith('524C555344'));
      if (rlusdKey) {
        result.rlusd_supply = parseFloat(obligations[rlusdKey]);
        log('XRPL', `rlusd_supply = ${result.rlusd_supply.toLocaleString()}`);
      } else {
        warn('XRPL', 'RLUSD currency not found in obligations');
      }
    } else {
      warn('XRPL', 'No obligations in gateway_balances response');
    }
  } catch (e) {
    err('XRPL', `gateway_balances: ${e.message}`);
  }

  // ── Call 3: ledger — transaction count + fee burn ──
  try {
    const controller3 = new AbortController();
    const timer3 = setTimeout(() => controller3.abort(), 15000);
    const r3 = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'ledger',
        params: [{ ledger_index: 'validated', transactions: true, expand: false }],
      }),
      signal: controller3.signal,
    });
    clearTimeout(timer3);
    const d3 = await r3.json();
    const ledger = d3?.result?.ledger;
    if (ledger) {
      const txnCount = ledger.transactions?.length ?? 0;
      result.last_ledger_txns = txnCount;
      if (ledger.ledger_index && !result.current_ledger) {
        result.current_ledger = parseInt(ledger.ledger_index, 10);
      }
      if (baseFeeXrp != null && txnCount > 0) {
        result.fee_burn_per_ledger_xrp = parseFloat((txnCount * baseFeeXrp).toFixed(8));
      }
      log('XRPL', `last_ledger_txns = ${txnCount}, fee_burn = ${result.fee_burn_per_ledger_xrp ?? 'N/A'} XRP`);
    } else {
      warn('XRPL', 'No ledger data in ledger response');
    }
  } catch (e) {
    err('XRPL', `ledger: ${e.message}`);
  }

  // ── Call 4: book_offers — XRP/USD order book (asks: selling XRP for USD) ──
  let asks = [];
  try {
    const controller4 = new AbortController();
    const timer4 = setTimeout(() => controller4.abort(), 15000);
    const r4 = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'book_offers',
        params: [{
          taker_gets: { currency: 'USD', issuer: BITSTAMP_USD },
          taker_pays: { currency: 'XRP' },
          limit: 10,
        }],
      }),
      signal: controller4.signal,
    });
    clearTimeout(timer4);
    const d4 = await r4.json();
    asks = d4?.result?.offers ?? [];
    log('XRPL', `book_offers asks: ${asks.length} offers`);
  } catch (e) {
    err('XRPL', `book_offers (asks): ${e.message}`);
  }

  // ── Call 5: book_offers — XRP/USD order book (bids: selling USD for XRP) ──
  let bids = [];
  try {
    const controller5 = new AbortController();
    const timer5 = setTimeout(() => controller5.abort(), 15000);
    const r5 = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'book_offers',
        params: [{
          taker_gets: { currency: 'XRP' },
          taker_pays: { currency: 'USD', issuer: BITSTAMP_USD },
          limit: 10,
        }],
      }),
      signal: controller5.signal,
    });
    clearTimeout(timer5);
    const d5 = await r5.json();
    bids = d5?.result?.offers ?? [];
    log('XRPL', `book_offers bids: ${bids.length} offers`);
  } catch (e) {
    err('XRPL', `book_offers (bids): ${e.message}`);
  }

  // ── Build book_depth_xrp_usd from asks + bids ──
  if (asks.length > 0 || bids.length > 0) {
    let totalAskXrp = 0;
    let bestAsk = null;
    for (const offer of asks) {
      const xrpDrops = typeof offer.TakerPays === 'string' ? parseInt(offer.TakerPays, 10) : 0;
      const xrpAmount = xrpDrops / 1_000_000;
      const usdAmount = typeof offer.TakerGets === 'object' ? parseFloat(offer.TakerGets.value) : 0;
      totalAskXrp += xrpAmount;
      if (bestAsk === null && xrpAmount > 0 && usdAmount > 0) {
        bestAsk = parseFloat((usdAmount / xrpAmount).toFixed(6));
      }
    }

    let totalBidXrp = 0;
    let bestBid = null;
    for (const offer of bids) {
      const xrpDrops = typeof offer.TakerGets === 'string' ? parseInt(offer.TakerGets, 10) : 0;
      const xrpAmount = xrpDrops / 1_000_000;
      const usdAmount = typeof offer.TakerPays === 'object' ? parseFloat(offer.TakerPays.value) : 0;
      totalBidXrp += xrpAmount;
      if (bestBid === null && xrpAmount > 0 && usdAmount > 0) {
        bestBid = parseFloat((usdAmount / xrpAmount).toFixed(6));
      }
    }

    result.book_depth_xrp_usd = {
      pair: 'XRP/USD',
      bids: bids.length,
      asks: asks.length,
      total_bid_xrp: parseFloat(totalBidXrp.toFixed(6)),
      total_ask_xrp: parseFloat(totalAskXrp.toFixed(6)),
      best_bid: bestBid,
      best_ask: bestAsk,
    };
    log('XRPL', `book_depth: ${bids.length} bids (${totalBidXrp.toFixed(2)} XRP), ${asks.length} asks (${totalAskXrp.toFixed(2)} XRP), best_bid=${bestBid}, best_ask=${bestAsk}`);
  }

  // ── Fallback check ──
  if (result.ledger_index === null && result.rlusd_supply === null) {
    warn('XRPL', 'Both primary calls failed, using fallback');
    return fallback?.xrpl_metrics ?? result;
  }
  return result;
}

// ─── x402 Agent Wallet fetcher ──────────────────────────────────────────────

/**
 * Fetches x402 agent wallet data directly from XRPL mainnet.
 * Two calls:
 *   1. account_info  — current XRP balance
 *   2. account_tx    — recent transactions (filtered to payments to merchant)
 *
 * This populates the x402 tab on the dashboard with live on-chain data
 * without requiring a manual x402-agent.js run.
 */
async function fetchX402Agent(fallback) {
  const AGENT_WALLET    = 'rPiok45Qs88WMYQbYzDqXQbPgaCr9PnX5M';
  const MERCHANT_WALLET = 'r4K5EDq2UPA2J6kecNKuFVAxs65gmfBYZP';
  const XRPL_URL        = ENDPOINTS.xrpl.server_info; // same rippled endpoint
  const fetchedAt       = new Date().toISOString();

  const result = {
    network:          'XRPL MAINNET',
    protocol:         'x402 v2',
    facilitator:      'T54 mainnet',
    agent_address:    AGENT_WALLET,
    merchant_address: MERCHANT_WALLET,
    merchant_base:    'https://t54.ai',
    balance_xrp:      null,
    payments_sent:    null,
    session_xrp_spent: 0,
    lifetime_xrp_spent: null,
    guardrails: {
      balance_floor_xrp: 11,
      session_cap_drops:  10000,
      max_single_drops:   5000,
    },
    transactions:     [],
    last_payment:     null,
    x402_flow:        null,
    last_updated:     fetchedAt,
  };

  // 1. account_info — get balance
  try {
    const controller1 = new AbortController();
    const timer1 = setTimeout(() => controller1.abort(), 15000);
    const r1 = await fetch(XRPL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'account_info',
        params: [{ account: AGENT_WALLET, ledger_index: 'validated' }],
      }),
      signal: controller1.signal,
    });
    clearTimeout(timer1);
    const d1 = await r1.json();
    const balanceDrops = d1?.result?.account_data?.Balance;
    if (balanceDrops) {
      result.balance_xrp = parseFloat((parseInt(balanceDrops, 10) / 1_000_000).toFixed(6));
      log('x402', `agent balance = ${result.balance_xrp} XRP`);
    } else {
      warn('x402', 'Could not read Balance from account_info');
    }
  } catch (e) {
    err('x402', `account_info: ${e.message}`);
  }

  // 2. account_tx — get recent transactions
  try {
    const controller2 = new AbortController();
    const timer2 = setTimeout(() => controller2.abort(), 15000);
    const r2 = await fetch(XRPL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'account_tx',
        params: [{
          account: AGENT_WALLET,
          ledger_index_min: -1,
          ledger_index_max: -1,
          limit: 50,
          forward: false,
        }],
      }),
      signal: controller2.signal,
    });
    clearTimeout(timer2);
    const d2 = await r2.json();
    const txs = d2?.result?.transactions;

    if (txs && Array.isArray(txs)) {
      const payments = txs
        .filter(t => {
          const tx = t.tx || t.tx_json || {};
          return tx.TransactionType === 'Payment'
            && tx.Account === AGENT_WALLET
            && tx.Destination === MERCHANT_WALLET;
        })
        .map(t => {
          const tx = t.tx || t.tx_json || {};
          const meta = t.meta || {};
          const amountDrops = typeof tx.Amount === 'string' ? parseInt(tx.Amount, 10) : 0;
          const amountXrp = parseFloat((amountDrops / 1_000_000).toFixed(6));

          let invoiceId = null;
          if (tx.Memos && Array.isArray(tx.Memos)) {
            for (const m of tx.Memos) {
              const memoData = m.Memo?.MemoData;
              if (memoData) {
                try {
                  invoiceId = Buffer.from(memoData, 'hex').toString('utf8');
                } catch (_) {
                  invoiceId = memoData;
                }
                break;
              }
            }
          }

          let endpoint = null;
          let label = 'x402 payment';
          if (invoiceId) {
            if (invoiceId.includes('premium-analysis') || invoiceId.includes('premium')) {
              endpoint = '/api/v1/premium-analysis';
              label = 'Premium Analysis';
            } else if (invoiceId.includes('bear-case') || invoiceId.includes('bear')) {
              endpoint = '/api/v1/bear-case';
              label = 'Bear Case Deep Dive';
            } else if (invoiceId.includes('stress-report') || invoiceId.includes('stress')) {
              endpoint = '/api/v1/stress-report';
              label = 'Stress Report';
            } else {
              endpoint = invoiceId;
              label = invoiceId;
            }
          }

          let timestamp = null;
          if (tx.date) {
            timestamp = new Date((tx.date + 946684800) * 1000).toISOString();
          }

          return {
            endpoint:     endpoint,
            label:        label,
            pay_to:       MERCHANT_WALLET,
            amount_drops: amountDrops,
            amount_xrp:   amountXrp,
            invoice_id:   invoiceId,
            tx_hash:      tx.hash || null,
            status:       meta.TransactionResult === 'tesSUCCESS' ? 'confirmed' : (meta.TransactionResult || 'unknown'),
            timestamp:    timestamp,
          };
        });

      result.payments_sent = payments.length;
      result.transactions = payments;

      const totalDrops = payments.reduce((sum, p) => sum + (p.amount_drops || 0), 0);
      result.lifetime_xrp_spent = parseFloat((totalDrops / 1_000_000).toFixed(6));

      if (payments.length > 0) {
        result.last_payment = payments[0];
      }

      if (payments.length > 0) {
        result.x402_flow = `${payments.length} mainnet payments • ${totalDrops.toLocaleString()} drops lifetime (${result.lifetime_xrp_spent} XRP)`;
      } else {
        result.x402_flow = 'No payments detected on-chain';
      }

      log('x402', `${payments.length} payments found, ${totalDrops} drops lifetime`);
    } else {
      warn('x402', 'No transactions in account_tx response');
    }
  } catch (e) {
    err('x402', `account_tx: ${e.message}`);
  }

  if (result.balance_xrp === null && result.payments_sent === null) {
    warn('x402', 'Both calls failed, using fallback');
    return fallback?.x402_agent ?? result;
  }

  return result;
}

// ─── Kill-switch helpers ──────────────────────────────────────────────────────

function pct(current, target) {
  if (current == null || target == null || target === 0) return null;
  return Math.round((current / target) * 100);
}

function buildKillSwitches(manual, rlusd) {
  const odl    = manual?.odl_volume_annualized ?? null;
  const rlusdC = rlusd?.market_cap ?? manual?.rlusd_circulation ?? null;
  const etfAum = manual?.xrp_etf_aum ?? null;
  const dex    = manual?.permissioned_dex_institutions ?? null;
  const clarity = manual?.clarity_act_status ?? 'pending';

  const T = KILL_SWITCH_TARGETS;

  return {
    odl_volume: {
      target:   T.odl_volume.target,
      current:  odl,
      deadline: T.odl_volume.deadline,
      status:   odl == null ? 'NEEDS_DATA' : odl >= T.odl_volume.target ? 'HIT' : 'TRACKING',
      pct_complete: pct(odl, T.odl_volume.target),
    },
    rlusd_circulation: {
      target:      T.rlusd_circulation.target,
      current:     rlusdC,
      deadline:    T.rlusd_circulation.deadline,
      status:      rlusdC == null ? 'NEEDS_DATA' : rlusdC >= T.rlusd_circulation.target ? 'HIT' : 'TRACKING',
      pct_complete: pct(rlusdC, T.rlusd_circulation.target),
    },
    xrp_etf_aum: {
      target:      T.xrp_etf_aum.target,
      current:     etfAum,
      deadline:    T.xrp_etf_aum.deadline,
      status:      etfAum == null ? 'NEEDS_DATA' : etfAum >= T.xrp_etf_aum.target ? 'HIT' : 'TRACKING',
      pct_complete: pct(etfAum, T.xrp_etf_aum.target),
    },
    permissioned_dex_adoption: {
      target_institutions: T.permissioned_dex_adoption.target_institutions,
      current:             dex,
      deadline:            T.permissioned_dex_adoption.deadline,
      status:              dex == null ? 'NEEDS_DATA' : dex >= T.permissioned_dex_adoption.target_institutions ? 'HIT' : 'TRACKING',
    },
    clarity_act: {
      target:   T.clarity_act.target,
      current:  'pending',
      deadline: T.clarity_act.deadline,
      status:   clarity?.toLowerCase().includes('passed') ? 'HIT' : 'PENDING',
    },
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n━━━ Overwatch Terminal — Data Fetch ━━━');
  console.log(`Started: ${new Date().toISOString()}\n`);

  const existing = loadExisting();

  const [xrp, rlusd, fearGreed, usdJpy] = await Promise.all([
    fetchXRP(existing),
    fetchRLUSD(existing),
    fetchFearGreed(existing),
    fetchUSDJPY(existing),
  ]);

  let brent = await fetchFinanceFlowCommodity('BRENT', ENDPOINTS.financeflow.brent, null);
  if (brent.value === null) {
    warn('BRENT', 'FinanceFlow failed, trying FRED fallback');
    brent = await fetchFRED('BRENT', ENDPOINTS.fred.brent, existing?.macro?.brent_crude);
  }
  const us10y  = await fetchFRED('US_10Y',  ENDPOINTS.fred.us_10y,  existing?.macro?.us_10y_yield);

  let jpn10y = await fetchFinanceFlowBond('JPN_10Y', ENDPOINTS.financeflow.jpn_10y, null);
  if (jpn10y.value === null) {
    warn('JPN_10Y', 'FinanceFlow failed, trying Stooq fallback');
    jpn10y = await fetchStooq('JPN_10Y', ENDPOINTS.stooq.jpn_10y, existing?.macro?.jpn_10y);
  }

  let dxy = await fetchFinanceFlowCurrency('DXY', ENDPOINTS.financeflow.dxy, null);
  if (dxy.value === null) {
    warn('DXY', 'FinanceFlow failed, trying Twelve Data fallback');
    dxy = await fetchTwelveData('DXY', ENDPOINTS.twelve_data.dxy, existing?.macro?.dxy);
  }

  let sp500 = await fetchStooq('SP500', ENDPOINTS.stooq.sp500, null);
  if (sp500.value === null) {
    warn('SP500', 'Stooq failed, trying Twelve Data fallback');
    sp500 = await fetchTwelveData('SP500', ENDPOINTS.twelve_data.sp500, existing?.macro?.sp500);
  }

  const xrplMetrics = await fetchXRPL(existing);
  const xIntelligence = await fetchXIntelligence(existing?.x_intelligence);
  const x402Agent = await fetchX402Agent(existing);

  const manual = {
    odl_volume_annualized:          existing?.manual?.odl_volume_annualized          ?? null,
    xrp_etf_aum:                    existing?.manual?.xrp_etf_aum                    ?? null,
    rlusd_circulation:              existing?.manual?.rlusd_circulation              ?? null,
    permissioned_dex_institutions:  existing?.manual?.permissioned_dex_institutions  ?? null,
    clarity_act_status:             existing?.manual?.clarity_act_status             ?? 'Pending',
    _last_manual_update:            existing?.manual?._last_manual_update            ?? null,
  };

  const thesis_scores = existing?.thesis_scores ?? {
    regulatory:             { status: 'CONFIRMED',     confidence: 'high'   },
    institutional_custody:  { status: 'STRONG',        confidence: 'high'   },
    etf_adoption:           { status: 'CONFIRMED',     confidence: 'high'   },
    xrpl_infrastructure:    { status: 'ACCELERATING',  confidence: 'high'   },
    stablecoin_adoption:    { status: 'GROWING',       confidence: 'medium' },
    odl_volume:             { status: 'NEEDS_DATA',    confidence: 'low'    },
    japan_adoption:         { status: 'FAVORABLE',     confidence: 'medium' },
    macro_environment:      { status: 'STRESSED',      confidence: 'medium' },
  };

  const output = {
    updated:      new Date().toISOString(),
    auto_fetched: true,
    xrp,
    rlusd,
    macro: {
      usd_jpy:       usdJpy,
      jpn_10y:       jpn10y,
      us_10y_yield:  us10y,
      brent_crude:   brent,
      dxy:           dxy,
      sp500:         sp500,
      fear_greed:    fearGreed,
    },
    xrpl_metrics: xrplMetrics,
    x_intelligence: xIntelligence,
    x402_agent: x402Agent,
    manual,
    kill_switches:  buildKillSwitches(manual, rlusd),
    thesis_scores,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  log('io', `Wrote ${OUTPUT_PATH}`);
  await validateDataContract();

  console.log('\n─── Summary ───────────────────────────────────');
  console.log(`XRP price:       ${xrp.price ?? 'N/A'}`);
  console.log(`RLUSD mktcap:    ${rlusd.market_cap?.toLocaleString() ?? 'N/A'} (${rlusd.source})`);
  console.log(`USD/JPY:         ${usdJpy.value ?? 'N/A'} (${usdJpy.data_date ?? 'no date'})`);
  console.log(`JPN 10Y yield:   ${jpn10y.value ?? 'N/A'}% (${jpn10y.data_date ?? 'no date'})`);
  console.log(`US 10Y yield:    ${us10y.value ?? 'N/A'}% (${us10y.data_date ?? 'no date'})`);
  console.log(`Brent crude:     ${brent.value ?? 'N/A'} (${brent.data_date ?? 'no date'})`);
  console.log(`DXY:             ${dxy.value ?? 'N/A'} (${dxy.data_date ?? 'no date'})`);
  console.log(`S&P 500:         ${sp500.value ?? 'N/A'} (${sp500.data_date ?? 'no date'})`);
  console.log(`Fear & Greed:    ${fearGreed.value ?? 'N/A'} (${fearGreed.label ?? 'N/A'}) (${fearGreed.data_date ?? 'no date'})`);
  console.log(`XRPL ledger:     #${xrplMetrics.current_ledger ?? 'N/A'}, ${xrplMetrics.last_ledger_txns ?? 'N/A'} txns, fee_burn=${xrplMetrics.fee_burn_per_ledger_xrp ?? 'N/A'} XRP`);
  console.log(`XRPL book:       ${xrplMetrics.book_depth_xrp_usd ? `${xrplMetrics.book_depth_xrp_usd.bids}b/${xrplMetrics.book_depth_xrp_usd.asks}a, best_bid=${xrplMetrics.book_depth_xrp_usd.best_bid}, best_ask=${xrplMetrics.book_depth_xrp_usd.best_ask}` : 'N/A'}`);
  console.log(`x402 agent:      ${x402Agent.payments_sent ?? 0} payments, ${x402Agent.balance_xrp ?? 'N/A'} XRP balance`);
  console.log('───────────────────────────────────────────────\n');

  await pushToGitHub();

  console.log(`\nDone: ${new Date().toISOString()}`);
}

main().catch(e => {
  console.error('\nFATAL:', e);
  process.exit(1);
});

// ─── Data Contract Validation ─────────────────────────────────────────────────

async function validateDataContract() {
  try {
    const contractPath = path.join(__dirname, '..', 'data-contract.json');
    const contract     = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    const dashboard    = JSON.parse(fs.readFileSync(OUTPUT_PATH,  'utf8'));

    const fields  = contract?.fields?.required_from_fetch ?? [];
    let populated = 0;
    const missing = [];

    for (const fieldPath of fields) {
      const keys = fieldPath.split('.');
      let value  = dashboard;
      for (const key of keys) {
        value = value?.[key];
      }
      if (value !== null && value !== undefined) {
        populated++;
      } else {
        missing.push(fieldPath);
      }
    }

    log('contract', `DATA CONTRACT: ${populated}/${fields.length} fields populated`);
    for (const f of missing) {
      warn('contract', `missing field: ${f}`);
    }

    try {
      const health = {
        fetch_timestamp:  new Date().toISOString(),
        fields_populated: populated,
        fields_total:     fields.length,
        missing_fields:   missing,
        status:           missing.length === 0 ? 'OK' : 'DEGRADED',
      };
      const healthPath = path.join(__dirname, 'pipeline-health.json');
      fs.writeFileSync(healthPath, JSON.stringify(health, null, 2));
      log('contract', `Pipeline health written (${health.status})`);
    } catch (writeErr) {
      err('contract', `Could not write pipeline-health.json (non-fatal): ${writeErr.message}`);
    }
  } catch (e) {
    err('contract', `Validation failed (non-fatal): ${e.message}`);
  }
}
