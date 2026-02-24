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
const pushToGitHub = require('./push-to-github');

const OUTPUT_PATH = path.join(__dirname, '..', 'dashboard-data.json');

// ─── Utilities ────────────────────────────────────────────────────────────────

function log(label, msg)  { console.log(`[${label}] ${msg}`); }
function warn(label, msg) { console.warn(`[${label}] WARN: ${msg}`); }
function err(label, msg)  { console.error(`[${label}] ERROR: ${msg}`); }

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry wrapper — calls fn() up to (1 + retries) times.
 * Waits delayMs before each retry. Throws on final failure.
 */
async function withRetry(fn, label, retries = 1, delayMs = 2_000) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      warn(label, `Attempt ${attempt} failed (${lastErr.message}) — retrying in ${delayMs}ms`);
      await sleep(delayMs);
    }
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** Health tracking — populated by each fetcher, included in output. */
const fetchHealth = {};

function markHealth(key, status, error) {
  fetchHealth[key] = { status, ts: new Date().toISOString(), ...(error ? { error: String(error) } : {}) };
}

/** Send a Telegram message. Used for critical failure alerts. */
async function sendTelegram(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    warn('Telegram', 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping notification');
    return false;
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`Telegram error: ${json.description}`);
    log('Telegram', 'Alert sent');
    return true;
  } catch (e) {
    err('Telegram', e.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
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
  try {
    const data = await withRetry(() => fetchJSON(ENDPOINTS.xrp), 'XRP');
    const r = data?.ripple;
    if (!r) throw new Error('Unexpected response shape');
    const result = {
      price:      r.usd              ?? null,
      change_24h: r.usd_24h_change   ?? null,
      volume_24h: r.usd_24h_vol      ?? null,
      market_cap: r.usd_market_cap   ?? null,
    };
    log('XRP', `price=$${result.price}  24h=${result.change_24h?.toFixed(2)}%`);
    markHealth('xrp', 'ok');
    return result;
  } catch (e) {
    err('XRP', e.message);
    markHealth('xrp', 'fail', e.message);
    return fallback?.xrp ?? { price: null, change_24h: null, volume_24h: null, market_cap: null };
  }
}

async function fetchRLUSD(fallback) {
  await sleep(COINGECKO_DELAY_MS);
  try {
    const data = await withRetry(() => fetchJSON(ENDPOINTS.rlusd), 'RLUSD');
    const r = data?.['ripple-usd'];
    if (!r) throw new Error('Unexpected response shape — will try search');
    const result = { market_cap: r.usd_market_cap ?? null, source: 'coingecko' };
    log('RLUSD', `market_cap=$${result.market_cap?.toLocaleString()}`);
    markHealth('rlusd', 'ok');
    return result;
  } catch (e) {
    warn('RLUSD', `Primary ID failed (${e.message}), trying search…`);
    try {
      await sleep(COINGECKO_DELAY_MS);
      const search = await withRetry(() => fetchJSON(ENDPOINTS.rlusd_search), 'RLUSD-search');
      const coin = search?.coins?.find(c => c.symbol?.toUpperCase() === 'RLUSD');
      if (!coin) throw new Error('RLUSD not found in search results');
      await sleep(COINGECKO_DELAY_MS);
      const data2 = await withRetry(() => fetchJSON(
        `https://api.coingecko.com/api/v3/simple/price?ids=${coin.id}&vs_currencies=usd&include_market_cap=true`
      ), 'RLUSD-price');
      const r2 = data2?.[coin.id];
      const result = { market_cap: r2?.usd_market_cap ?? null, source: 'coingecko' };
      log('RLUSD', `market_cap=$${result.market_cap?.toLocaleString()} (via search id=${coin.id})`);
      markHealth('rlusd', 'ok');
      return result;
    } catch (e2) {
      err('RLUSD', e2.message);
      markHealth('rlusd', 'fail', e2.message);
      return fallback?.rlusd ?? { market_cap: null, source: 'manual' };
    }
  }
}

async function fetchFearGreed(fallback) {
  try {
    const data = await withRetry(() => fetchJSON(ENDPOINTS.fear_greed), 'FearGreed');
    const entry = data?.data?.[0];
    if (!entry) throw new Error('Unexpected response shape');
    const result = {
      value: Number(entry.value),
      label: entry.value_classification,
    };
    log('Fear&Greed', `${result.value} — ${result.label}`);
    markHealth('fear_greed', 'ok');
    return result;
  } catch (e) {
    err('Fear&Greed', e.message);
    markHealth('fear_greed', 'fail', e.message);
    return fallback?.macro?.fear_greed ?? { value: null, label: null };
  }
}

async function fetchUSDJPY(fallback) {
  // ── Alpha Vantage (primary — real-time FX) ─────────────────────────────
  const avKey = process.env.ALPHA_VANTAGE_KEY;
  if (avKey) {
    try {
      const url = `https://www.alphavantage.co/query?function=FX_DAILY&from_symbol=USD&to_symbol=JPY&outputsize=compact&apikey=${encodeURIComponent(avKey)}`;
      const data = await withRetry(() => fetchJSON(url, 12_000), 'USD/JPY-AV');
      const timeSeries = data?.['Time Series FX (Daily)'];
      if (!timeSeries) throw new Error('No time series in Alpha Vantage response');
      const latestDate = Object.keys(timeSeries).sort().pop();
      const rate = parseFloat(timeSeries[latestDate]?.['4. close']);
      if (!rate || isNaN(rate)) throw new Error('Could not parse Alpha Vantage FX rate');
      log('USD/JPY', `${rate} (Alpha Vantage, date: ${latestDate})`);
      markHealth('usd_jpy', 'ok');
      return rate;
    } catch (e) {
      warn('USD/JPY', `Alpha Vantage failed (${e.message}) — trying Frankfurter`);
    }
  } else {
    warn('USD/JPY', 'ALPHA_VANTAGE_KEY not set — using Frankfurter');
  }

  // ── Frankfurter (fallback — ECB rates, may lag 1-2 days) ───────────────
  try {
    const data = await withRetry(() => fetchJSON(ENDPOINTS.usd_jpy), 'USD/JPY-FX');
    const rate = data?.rates?.JPY;
    if (!rate) throw new Error('Unexpected response shape');
    log('USD/JPY', `${rate} (Frankfurter)`);
    markHealth('usd_jpy', 'ok');
    return rate;
  } catch (e) {
    err('USD/JPY', e.message);
    markHealth('usd_jpy', 'fail', e.message);
    return fallback?.macro?.usd_jpy ?? null;
  }
}

/**
 * Fetch Japan 10Y bond yield.
 * Tries Twelve Data (daily updates) first, falls back to FRED (2-day lag).
 */
async function fetchJPN10Y(fallbackValue) {
  // ── Twelve Data (primary — daily bond yield) ──────────────────────────
  const tdKey = process.env.TWELVE_DATA_KEY;
  if (tdKey) {
    try {
      const url = `https://api.twelvedata.com/time_series?symbol=JP10Y&interval=1day&outputsize=1&apikey=${encodeURIComponent(tdKey)}`;
      const data = await withRetry(() => fetchJSON(url, 12_000), 'JPN10Y-TD');
      const values = data?.values;
      if (!Array.isArray(values) || values.length === 0) throw new Error('No values in Twelve Data response');
      const value = parseFloat(values[0]?.close);
      if (isNaN(value)) throw new Error('Could not parse Twelve Data yield');
      log('FRED', `JPN_10Y = ${value} (Twelve Data, date: ${values[0]?.datetime})`);
      markHealth('fred_jpn_10y', 'ok');
      return value;
    } catch (e) {
      warn('JPN10Y', `Twelve Data failed (${e.message}) — falling back to FRED`);
    }
  } else {
    warn('JPN10Y', 'TWELVE_DATA_KEY not set — using FRED');
  }

  // ── FRED (fallback — monthly series, may lag 1-3 days) ────────────────
  return fetchFRED('JPN_10Y', ENDPOINTS.fred.jpn_10y, fallbackValue);
}

/**
 * Fetch a single FRED series. Returns the most recent non-null observation value.
 */
async function fetchFRED(seriesLabel, url, fallbackValue) {
  const key = process.env.FRED_API_KEY;
  const healthKey = `fred_${seriesLabel.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
  if (!key) {
    warn('FRED', `FRED_API_KEY not set — skipping ${seriesLabel}`);
    markHealth(healthKey, 'skip');
    return fallbackValue ?? null;
  }
  try {
    const fullUrl = `${url}&api_key=${encodeURIComponent(key)}`;
    const data = await withRetry(() => fetchJSON(fullUrl), `FRED-${seriesLabel}`);
    const obs = data?.observations?.find(o => o.value !== '.' && o.value !== '');
    if (!obs) throw new Error('No valid observation in response');
    const value = parseFloat(obs.value);
    log('FRED', `${seriesLabel} = ${value} (date: ${obs.date})`);
    markHealth(healthKey, 'ok');
    return value;
  } catch (e) {
    err('FRED', `${seriesLabel}: ${e.message}`);
    markHealth(healthKey, 'fail', e.message);
    return fallbackValue ?? null;
  }
}

// ─── BTC / ETH ETF fetchers (iShares IBIT + ETHA) ────────────────────────────

const ISHARES_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Accept':     'text/plain,text/csv,*/*',
};

/**
 * Parse an iShares fund CSV and extract AUM, shares outstanding, and as-of date.
 * Tracks day-over-day share delta to compute net flows.
 * Maintains a rolling daily_flow_history array (up to 14 entries) for 5-day sums.
 */
async function fetchISharesETF({ label, csvUrl, assetRegex, fallbackKey, fallback }) {
  const healthKey = label.toLowerCase();
  try {
    const res = await withRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const r = await fetch(csvUrl, { headers: ISHARES_HEADERS, signal: controller.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r;
      } finally {
        clearTimeout(timer);
      }
    }, label);
    const csv = await res.text();

    // Header fields — date is quoted e.g. Fund Holdings as of,"Feb 20, 2026"
    const asOfMatch     = csv.match(/Fund Holdings as of[^"]*"([^"]+)"/i);
    const sharesMatch   = csv.match(/Shares Outstanding[,"\s]+"?([0-9,.]+)"?/i);
    const assetRow      = csv.match(assetRegex);

    if (!sharesMatch || !assetRow) throw new Error(`Could not parse ${label} CSV`);

    const as_of_date       = asOfMatch ? new Date(asOfMatch[1].trim()).toISOString().substring(0, 10) : null;
    const shares_outstanding = parseFloat(sharesMatch[1].replace(/,/g, ''));
    const total_aum          = parseFloat(assetRow[1].replace(/,/g, ''));
    const nav_per_share      = total_aum / shares_outstanding;

    const prev = fallback?.[fallbackKey] ?? {};
    let daily_flow = null;
    const daily_flow_history = Array.isArray(prev.daily_flow_history) ? [...prev.daily_flow_history] : [];

    // Append new daily flow when as_of_date advances
    if (as_of_date && as_of_date !== prev.as_of_date && prev.shares_outstanding != null) {
      daily_flow = (shares_outstanding - prev.shares_outstanding) * nav_per_share;
      daily_flow_history.push({ date: as_of_date, flow: daily_flow });
      if (daily_flow_history.length > 14) daily_flow_history.shift();
    } else if (daily_flow_history.length > 0) {
      // Re-use last known daily flow if date hasn't changed
      daily_flow = daily_flow_history.at(-1).flow;
    }

    // 5-day (last 5 trading days) net flow
    const last5 = daily_flow_history.slice(-5);
    const weekly_net_flow = last5.length >= 1 ? last5.reduce((s, d) => s + d.flow, 0) : null;

    const result = {
      last_fetched: new Date().toISOString(),
      source:       `ishares-${label.toLowerCase()}`,
      ticker:       label,
      as_of_date,
      total_aum,
      shares_outstanding,
      nav_per_share,
      daily_flow,
      weekly_net_flow,
      daily_flow_history,
    };

    log(label, `AUM=$${(total_aum / 1e9).toFixed(2)}B | shares=${(shares_outstanding / 1e6).toFixed(0)}M | daily_flow=${daily_flow != null ? (daily_flow >= 0 ? '+' : '') + '$' + (daily_flow / 1e6).toFixed(0) + 'M' : 'N/A (first run)'}`);
    markHealth(healthKey, 'ok');
    return result;
  } catch (e) {
    err(label, e.message);
    markHealth(healthKey, 'fail', e.message);
    return fallback?.[fallbackKey] ?? {
      last_fetched: null, source: 'none', ticker: label,
      as_of_date: null, total_aum: null, shares_outstanding: null,
      nav_per_share: null, daily_flow: null, weekly_net_flow: null,
      daily_flow_history: [],
    };
  }
}

function fetchBTCETF(fallback) {
  return fetchISharesETF({
    label:      'IBIT',
    csvUrl:     'https://www.ishares.com/us/products/333011/fund/1467271812596.ajax?fileType=csv&fileName=IBIT_holdings&dataType=fund',
    assetRegex: /"BTC","BITCOIN","-","Alternative","([0-9,.]+)"/i,
    fallbackKey: 'btc_etf',
    fallback,
  });
}

function fetchETHETF(fallback) {
  return fetchISharesETF({
    label:      'ETHA',
    csvUrl:     'https://www.ishares.com/us/products/337614/fund/1467271812596.ajax?fileType=csv&fileName=ETHA_holdings&dataType=fund',
    assetRegex: /"ETH","ETHER","-","Alternative","([0-9,.]+)"/i,
    fallbackKey: 'eth_etf',
    fallback,
  });
}

// ─── XRP ETF fetcher ──────────────────────────────────────────────────────────

/**
 * Fetch XRP ETF data from xrp-insights.com's internal API.
 * Returns total AUM, total XRP locked, daily flows, and per-fund breakdown.
 * Always returns an "etf" object — never throws.
 */
async function fetchETF(fallback) {
  try {
    const res = await withRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const r = await fetch('https://xrp-insights.com/api/flows?days=14', {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Overwatch-Terminal/1.0)',
            'Accept':     'application/json',
            'Referer':    'https://xrp-insights.com/',
          },
          signal: controller.signal,
        });
        if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
        return r;
      } finally {
        clearTimeout(timer);
      }
    }, 'ETF');
    const data = await res.json();

    if (!data?.success || !Array.isArray(data?.daily) || data.daily.length === 0) {
      throw new Error('Unexpected response shape from xrp-insights API');
    }

    // Sort newest-first; drop weekends
    const tradingDays = [...data.daily]
      .filter(d => !d.isWeekend)
      .sort((a, b) => b.date.localeCompare(a.date));

    const latest       = tradingDays[0];
    const latestWithFlow = tradingDays.find(d => d.inflow !== 0 || d.outflow !== 0) ?? latest;

    // Weekly = last 5 trading days
    const week5 = tradingDays.slice(0, 5);
    const weeklyNetFlow  = week5.reduce((s, d) => s + (d.netFlow  ?? 0), 0);
    const weeklyInflow   = week5.reduce((s, d) => s + (d.inflow   ?? 0), 0);
    const weeklyOutflow  = week5.reduce((s, d) => s + (d.outflow  ?? 0), 0);

    // 14-day cumulative
    const allDays = [...data.daily].sort((a, b) => b.date.localeCompare(a.date));
    const cumNetFlow = allDays.reduce((s, d) => s + (d.netFlow ?? 0), 0);
    const cumInflow  = allDays.reduce((s, d) => s + (d.inflow  ?? 0), 0);

    const funds = (latest.etfFlows ?? []).map(f => ({
      ticker:     f.ticker,
      issuer:     f.issuer,
      aum:        f.aum          ?? null,
      xrp_locked: f.xrpHoldings  ?? null,
      daily_flow: f.flow         ?? null,
    }));

    const result = {
      last_fetched:       new Date().toISOString(),
      source:             'xrp-insights',
      as_of_date:         latest.date,
      total_aum:          latest.totalAUM        ?? null,
      total_xrp_locked:   latest.totalXRP        ?? null,
      daily_net_flow:     latestWithFlow.netFlow  ?? null,
      daily_inflow:       latestWithFlow.inflow   ?? null,
      daily_outflow:      latestWithFlow.outflow  ?? null,
      flow_date:          latestWithFlow.date     ?? null,
      weekly_net_flow:    weeklyNetFlow,
      weekly_inflow:      weeklyInflow,
      weekly_outflow:     weeklyOutflow,
      weekly_start_date:  week5.at(-1)?.date      ?? null,
      cum_net_flow:       cumNetFlow,
      cum_inflow:         cumInflow,
      funds,
    };

    log('ETF', `AUM=$${(result.total_aum / 1e6).toFixed(1)}M | XRP=${(result.total_xrp_locked / 1e6).toFixed(0)}M | 5D flow=${(weeklyNetFlow / 1e6).toFixed(2)}M | funds=${funds.length}`);
    markHealth('etf', 'ok');
    return result;
  } catch (e) {
    err('ETF', e.message);
    markHealth('etf', 'fail', e.message);
    return fallback?.etf ?? {
      last_fetched:     null,
      source:           'none',
      total_aum:        null,
      total_xrp_locked: null,
      daily_net_flow:   null,
      daily_inflow:     null,
      daily_outflow:    null,
      funds:            [],
    };
  }
}

// ─── XRP Supply / Radar fetcher ───────────────────────────────────────────────

/**
 * Fetch XRP supply distribution from xrp-insights.com/api/allocations.
 * Returns escrow, exchange holdings, DeFi locked, corporate treasuries, etc.
 * Always returns a "supply" object — never throws.
 */
async function fetchXRPRadar(fallback) {
  try {
    const res = await withRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const r = await fetch('https://xrp-insights.com/api/allocations', {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Overwatch-Terminal/1.0)',
            'Accept':     'application/json',
            'Referer':    'https://xrp-insights.com/xrp-radar',
          },
          signal: controller.signal,
        });
        if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
        return r;
      } finally {
        clearTimeout(timer);
      }
    }, 'Supply');
    const json = await res.json();
    if (!json.success || !json.data) throw new Error('Unexpected response shape');

    const d = json.data;

    const escrow          = d.supplyBreakdown?.escrow?.amount          ?? null;
    const exchanges       = d.exchanges?.totalXrp                      ?? null;
    const defi_total      = d.defi?.totalXrp                           ?? null;
    const corp_treasuries = d.treasuries?.totalXrp                     ?? null;
    const circ_supply     = d.circulatingSupply                        ?? null;
    const total_supply    = d.totalSupply                              ?? 100_000_000_000;
    const xrp_burned      = d.xrpBurned                               ?? null;
    const amm_locked      = d.infrastructureDemand?.ammXrpLocked      ?? null;

    const result = {
      last_fetched:     new Date().toISOString(),
      source:           'xrp-insights',
      total_supply,
      circ_supply,
      escrow,
      exchanges,
      defi_total,
      corp_treasuries,
      amm_locked,
      xrp_burned,
    };

    log('Supply', `Escrow=${escrow ? (escrow / 1e9).toFixed(2) + 'B' : 'N/A'} | Exchanges=${exchanges ? (exchanges / 1e9).toFixed(1) + 'B' : 'N/A'} | DeFi=${defi_total ? (defi_total / 1e6).toFixed(0) + 'M' : 'N/A'} | Corp=${corp_treasuries ? (corp_treasuries / 1e6).toFixed(0) + 'M' : 'N/A'}`);
    markHealth('supply', 'ok');
    return result;
  } catch (e) {
    err('Supply', e.message);
    markHealth('supply', 'fail', e.message);
    return fallback?.supply ?? {
      last_fetched:     null,
      source:           'none',
      total_supply:     100_000_000_000,
      circ_supply:      null,
      escrow:           null,
      exchanges:        null,
      defi_total:       null,
      corp_treasuries:  null,
      amm_locked:       null,
      xrp_burned:       null,
    };
  }
}

// ─── XRPL on-chain metrics (native rippled JSON-RPC) ─────────────────────────

const RIPPLED_URL = 'https://s1.ripple.com:51234';

/**
 * Send a JSON-RPC request to the public rippled server.
 * Returns result object or throws on network/XRPL error.
 */
async function rippleRPC(method, params = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(RIPPLED_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ method, params: [params] }),
      signal:  controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const json = await res.json();
    if (json.result?.status === 'error') {
      throw new Error(`XRPL ${method}: ${json.result.error_message ?? json.result.error}`);
    }
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch XRPL network metrics directly from a public rippled server.
 * Queries: server_info, 6 consecutive ledgers (5-sample avg), book_offers XRP/USD.
 * Always returns an "xrpl_metrics" object — never throws.
 */
async function fetchXRPLMetrics(fallback) {
  const EMPTY_FALLBACK = fallback?.xrpl_metrics ?? {
    last_fetched: null, source: 'none',
    current_ledger: null, last_ledger_txns: null,
    avg_tx_per_ledger: null, fee_burn_per_ledger_xrp: null,
    book_depth_xrp_usd: null,
    dex_volume_24h_usd: null, dex_volume_24h_xrp: null,
    dex_exchanges_24h: null, dex_takers_24h: null,
  };

  try {
    // 1. server_info — get validated ledger sequence
    const serverInfo = await withRetry(() => rippleRPC('server_info'), 'XRPL-server_info');
    const validatedSeq = serverInfo?.info?.validated_ledger?.seq;
    if (!validatedSeq) throw new Error('validated_ledger.seq missing from server_info');
    log('XRPL', `server_info ok — validated ledger: ${validatedSeq}`);

    // 2. Fetch 6 consecutive ledgers: (seq-5) through (seq).
    //    transactions:true, expand:false  → hash list for tx counts.
    //    total_coins in header → BigInt diff gives fee burn without precision loss.
    const indices = Array.from({ length: 6 }, (_, i) => validatedSeq - 5 + i);
    const ledgerResults = await Promise.all(
      indices.map(idx =>
        withRetry(
          () => rippleRPC('ledger', { ledger_index: idx, transactions: true, expand: false }, 12_000),
          `XRPL-ledger-${idx}`
        )
      )
    );

    // Tx counts for the 5 most recent ledgers (indices[1..5])
    const sampleLedgers = ledgerResults.slice(1);
    const txCounts = sampleLedgers.map(r => {
      const txs = r?.ledger?.transactions;
      return Array.isArray(txs) ? txs.length : 0;
    });
    const last_ledger_txns   = txCounts[txCounts.length - 1];
    const avg_tx_per_ledger  = Math.round(txCounts.reduce((s, v) => s + v, 0) / txCounts.length);

    // Fee burn: total_coins (drops) is a large integer string — use BigInt to avoid
    // precision loss (value ~9.999e16 exceeds Number.MAX_SAFE_INTEGER).
    let fee_burn_per_ledger_xrp = null;
    const oldestCoins = ledgerResults[0]?.ledger?.total_coins;
    const newestCoins = ledgerResults[5]?.ledger?.total_coins;
    if (oldestCoins && newestCoins) {
      const burnDrops = BigInt(oldestCoins) - BigInt(newestCoins);
      if (burnDrops > 0n) {
        fee_burn_per_ledger_xrp = parseFloat((Number(burnDrops) / 1_000_000 / 5).toFixed(4));
      }
    }

    log('XRPL', `ledgers ok — last_txns=${last_ledger_txns} | avg=${avg_tx_per_ledger} tx/ledger | burn=${fee_burn_per_ledger_xrp ?? 'N/A'} XRP/ledger`);

    // 3. book_offers — try GateHub USD first, Bitstamp USD as fallback, top 10 each side.
    //    taker_gets=XRP / taker_pays=USD  → bids (XRP sellers, TakerGets=drops string)
    //    taker_gets=USD / taker_pays=XRP  → asks (USD sellers, TakerGets=USD object)
    //    XRP must be {"currency":"XRP"} with no issuer field.
    const USD_ISSUERS = [
      { label: 'GateHub',  issuer: 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq' },
      { label: 'Bitstamp', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B'  },
    ];
    const XRP_NATIVE = { currency: 'XRP' };

    let book_depth_xrp_usd = null;
    for (const { label, issuer } of USD_ISSUERS) {
      const USD = { currency: 'USD', issuer };
      try {
        const [bidsResult, asksResult] = await Promise.all([
          withRetry(() => rippleRPC('book_offers', { taker_gets: XRP_NATIVE, taker_pays: USD, limit: 10 }, 12_000), `XRPL-bids-${label}`),
          withRetry(() => rippleRPC('book_offers', { taker_gets: USD, taker_pays: XRP_NATIVE, limit: 10 }, 12_000), `XRPL-asks-${label}`),
        ]);

        // Bids: TakerGets=XRP drops string, TakerPays=USD object with .value
        const bids = (bidsResult?.offers ?? []).map(o => ({
          xrp: Number(o.TakerGets) / 1_000_000,
          usd: Number(o.TakerPays?.value ?? 0),
        }));
        // Asks: TakerGets=USD object with .value, TakerPays=XRP drops string
        const asks = (asksResult?.offers ?? []).map(o => ({
          xrp: Number(o.TakerPays) / 1_000_000,
          usd: Number(o.TakerGets?.value ?? 0),
        }));

        if (bids.length === 0 && asks.length === 0) {
          warn('XRPL', `book_offers ${label}: no offers on either side — trying next issuer`);
          continue;
        }

        const totalBidXrp = bids.reduce((s, o) => s + o.xrp, 0);
        const totalAskXrp = asks.reduce((s, o) => s + o.xrp, 0);

        book_depth_xrp_usd = {
          pair:          `XRP/USD.${label}`,
          bids:          bids.length,
          asks:          asks.length,
          total_bid_xrp: Math.round(totalBidXrp),
          total_ask_xrp: Math.round(totalAskXrp),
          best_bid:      bids[0] ?? null,
          best_ask:      asks[0] ?? null,
        };

        log('XRPL', `book XRP/USD.${label} — ${bids.length} bids (${(totalBidXrp / 1000).toFixed(0)}K XRP) / ${asks.length} asks (${(totalAskXrp / 1000).toFixed(0)}K XRP)`);
        break;
      } catch (bookErr) {
        const next = label === 'GateHub' ? 'trying Bitstamp' : 'giving up';
        warn('XRPL', `book_offers ${label} failed: ${bookErr.message} — ${next}`);
      }
    }

    const result = {
      last_fetched:            new Date().toISOString(),
      source:                  'xrpl_native',
      current_ledger:          validatedSeq,
      last_ledger_txns,
      avg_tx_per_ledger,
      fee_burn_per_ledger_xrp,
      book_depth_xrp_usd,
      // DEX 24h volume not available from native API
      dex_volume_24h_usd:      null,
      dex_volume_24h_xrp:      null,
      dex_exchanges_24h:       null,
      dex_takers_24h:          null,
    };

    markHealth('xrpl_metrics', 'ok');
    return result;
  } catch (e) {
    err('XRPL', e.message);
    markHealth('xrpl_metrics', 'fail', e.message);
    return EMPTY_FALLBACK;
  }
}

// ─── News fetcher ─────────────────────────────────────────────────────────────

/**
 * Fetch recent XRP/Ripple news headlines.
 * Tries CryptoPanic free tier first (requires CRYPTOPANIC_API_KEY);
 * falls back to NewsData.io if NEWSDATA_API_KEY is set.
 * Always returns a "news" object — never throws.
 */
async function fetchNews(fallback) {
  // ── CryptoPanic ────────────────────────────────────────────────────────────
  const cpKey = process.env.CRYPTOPANIC_API_KEY;
  if (cpKey) {
    try {
      await sleep(500);
      const cpUrl = `https://cryptopanic.com/api/free/v1/posts/?auth_token=${encodeURIComponent(cpKey)}&currencies=XRP&kind=news&filter=important`;
      const data = await withRetry(() => fetchJSON(cpUrl, 12_000), 'News-CryptoPanic');
      const results = data?.results;
      if (!Array.isArray(results) || results.length === 0) throw new Error('Empty or unexpected CryptoPanic response');

      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const headlines = results
        .filter(p => p.title && new Date(p.published_at).getTime() > cutoff)
        .slice(0, 15)
        .map(p => ({
          title:     p.title,
          source:    p.source?.title ?? 'CryptoPanic',
          url:       p.url ?? '',
          published: p.published_at ?? null,
        }));

      log('News', `CryptoPanic: ${headlines.length} headlines (last 24h)`);
      markHealth('news', 'ok');
      return { last_fetched: new Date().toISOString(), source: 'cryptopanic', headlines };
    } catch (e) {
      warn('News', `CryptoPanic failed (${e.message}) — trying NewsData.io`);
    }
  } else {
    warn('News', 'CRYPTOPANIC_API_KEY not set — skipping CryptoPanic');
  }

  // ── NewsData.io fallback ───────────────────────────────────────────────────
  const ndKey = process.env.NEWSDATA_API_KEY;
  if (ndKey) {
    try {
      const ndUrl = `https://newsdata.io/api/1/news?apikey=${encodeURIComponent(ndKey)}&q=XRP%20OR%20Ripple%20OR%20XRPL%20OR%20RLUSD&language=en&size=10&category=technology,business,top`;
      const data = await withRetry(() => fetchJSON(ndUrl, 12_000), 'News-NewsData');
      const results = data?.results;
      if (!Array.isArray(results) || results.length === 0) throw new Error('Empty NewsData.io response');

      const XRP_RE = /\b(?:XRP|Ripple|XRPL|RLUSD|ODL|OnDemandLiquidity|RippleNet)\b|stablecoin\s+settlement|tokenized\s+treasury|cross[- ]border\s+payment\s+blockchain|SBI\s+Holdings\s+blockchain/i;
      const relevant = results.filter(p => XRP_RE.test((p.title ?? '') + ' ' + (p.description ?? '')));
      const pool = relevant.length >= 1 ? relevant : results;

      const headlines = pool.slice(0, 15).map(p => ({
        title:     p.title ?? '',
        source:    p.source_id ?? 'NewsData',
        url:       p.link ?? '',
        published: p.pubDate ?? null,
      }));

      log('News', `NewsData.io: ${headlines.length} headlines (${relevant.length} XRP-relevant of ${results.length} returned)`);
      markHealth('news', 'ok');
      return { last_fetched: new Date().toISOString(), source: 'newsdata', headlines };
    } catch (e2) {
      err('News', `NewsData.io also failed: ${e2.message}`);
      markHealth('news', 'fail', e2.message);
    }
  } else {
    warn('News', 'NEWSDATA_API_KEY not set — no fallback available');
    markHealth('news', 'skip');
  }

  // ── Graceful degradation ───────────────────────────────────────────────────
  warn('News', 'Using cached/empty headlines');
  return fallback?.news ?? { last_fetched: new Date().toISOString(), source: 'none', headlines: [] };
}

// ─── Kill-switch helpers ──────────────────────────────────────────────────────

function pct(current, target) {
  if (current == null || target == null || target === 0) return null;
  return Math.round((current / target) * 100);
}

function buildKillSwitches(manual, rlusd, etf) {
  const odl    = manual?.odl_volume_annualized ?? null;
  const rlusdC = rlusd?.market_cap ?? manual?.rlusd_circulation ?? null;
  const etfAum = etf?.total_aum ?? manual?.xrp_etf_aum ?? null;
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

  // Fetch all live data. Each fetcher is self-contained and falls back gracefully.
  const [xrp, rlusd, fearGreed, usdJpy, news, etf, supply, btc_etf, eth_etf, xrpl_metrics] = await Promise.all([
    fetchXRP(existing),
    fetchRLUSD(existing),
    fetchFearGreed(existing),
    fetchUSDJPY(existing),
    fetchNews(existing),
    fetchETF(existing),
    fetchXRPRadar(existing),
    fetchBTCETF(existing),
    fetchETHETF(existing),
    fetchXRPLMetrics(existing),
  ]);

  // Compute XRPL DEX volume in XRP terms now that we have the XRP price
  if (xrpl_metrics.dex_volume_24h_usd != null && xrp.price != null && xrp.price > 0) {
    xrpl_metrics.dex_volume_24h_xrp = Math.round(xrpl_metrics.dex_volume_24h_usd / xrp.price);
  }

  // Enrich ETF with % of circulating supply (market_cap / price = circ. supply)
  if (etf.total_xrp_locked != null && xrp.market_cap != null && xrp.price != null && xrp.price > 0) {
    const circSupply = xrp.market_cap / xrp.price;
    etf.pct_supply   = parseFloat(((etf.total_xrp_locked / circSupply) * 100).toFixed(3));
    etf.circ_supply  = Math.round(circSupply);
  }
  etf.num_funds = etf.funds?.length ?? 0;

  // FRED/Twelve Data calls are sequential to avoid hammering the APIs
  const jpn10y = await fetchJPN10Y(existing?.macro?.jpn_10y);
  const brent  = await fetchFRED('BRENT',   ENDPOINTS.fred.brent,   existing?.macro?.brent_crude);
  const us10y  = await fetchFRED('US_10Y',  ENDPOINTS.fred.us_10y,  existing?.macro?.us_10y_yield);

  // Preserve manually-managed fields from existing JSON (never overwrite with null)
  const manual = {
    odl_volume_annualized:          existing?.manual?.odl_volume_annualized          ?? null,
    xrp_etf_aum:                    existing?.manual?.xrp_etf_aum                    ?? null,
    rlusd_circulation:              existing?.manual?.rlusd_circulation              ?? null,
    permissioned_dex_institutions:  existing?.manual?.permissioned_dex_institutions  ?? null,
    clarity_act_status:             existing?.manual?.clarity_act_status             ?? 'Pending',
    _last_manual_update:            existing?.manual?._last_manual_update            ?? null,
  };

  // Preserve thesis scores — these are editorially managed
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
    etf,
    btc_etf,
    eth_etf,
    supply,
    xrpl_metrics,
    macro: {
      usd_jpy:       usdJpy,
      jpn_10y: jpn10y,
      us_10y_yield:  us10y,
      brent_crude:   brent,
      fear_greed:    fearGreed,
    },
    news,
    manual,
    kill_switches:  buildKillSwitches(manual, rlusd, etf),
    thesis_scores,
    health_check:   fetchHealth,
    // Preserve bear_case — managed by apply-analysis.js / Claude analyst
    bear_case:      existing?.bear_case ?? null,
    // Preserve probability model — managed by apply-analysis.js
    probability:    existing?.probability ?? null,
    // Preserve last_analysis stamp
    last_analysis:  existing?.last_analysis ?? null,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  log('io', `Wrote ${OUTPUT_PATH}`);

  // Alert if too many sources failed
  const failedSources = Object.entries(fetchHealth)
    .filter(([, h]) => h.status === 'fail')
    .map(([k]) => k);
  if (failedSources.length >= 3) {
    const msg = `⚠️ <b>OVERWATCH: ${failedSources.length} data sources failed</b>\n\nFailed: ${failedSources.join(', ')}\nCycle: ${new Date().toISOString()}`;
    await sendTelegram(msg);
  }

  console.log('\n─── Summary ───────────────────────────────────');
  console.log(`XRP price:       $${xrp.price ?? 'N/A'}`);
  console.log(`RLUSD mktcap:    $${rlusd.market_cap?.toLocaleString() ?? 'N/A'} (${rlusd.source})`);
  console.log(`USD/JPY:         ${usdJpy ?? 'N/A'}`);
  console.log(`JPN 10Y yield:   ${jpn10y ?? 'N/A'}%`);
  console.log(`US 10Y yield:    ${us10y ?? 'N/A'}%`);
  console.log(`Brent crude:     $${brent ?? 'N/A'}`);
  console.log(`Fear & Greed:    ${fearGreed.value ?? 'N/A'} (${fearGreed.label ?? 'N/A'})`);
  console.log(`XRP ETF AUM:     $${etf.total_aum != null ? (etf.total_aum / 1e6).toFixed(1) + 'M' : 'N/A'} | flow 5D: ${etf.weekly_net_flow != null ? (etf.weekly_net_flow / 1e6).toFixed(1) + 'M' : 'N/A'}`);
  console.log(`BTC ETF (IBIT):  $${btc_etf.total_aum != null ? (btc_etf.total_aum / 1e9).toFixed(2) + 'B' : 'N/A'} | daily: ${btc_etf.daily_flow != null ? (btc_etf.daily_flow >= 0 ? '+' : '') + (btc_etf.daily_flow / 1e6).toFixed(0) + 'M' : 'N/A'} | 5D: ${btc_etf.weekly_net_flow != null ? (btc_etf.weekly_net_flow / 1e6).toFixed(0) + 'M' : 'N/A'}`);
  console.log(`ETH ETF (ETHA):  $${eth_etf.total_aum != null ? (eth_etf.total_aum / 1e9).toFixed(2) + 'B' : 'N/A'} | daily: ${eth_etf.daily_flow != null ? (eth_etf.daily_flow >= 0 ? '+' : '') + (eth_etf.daily_flow / 1e6).toFixed(0) + 'M' : 'N/A'} | 5D: ${eth_etf.weekly_net_flow != null ? (eth_etf.weekly_net_flow / 1e6).toFixed(0) + 'M' : 'N/A'}`);
  console.log(`News headlines:  ${news.headlines.length} (source: ${news.source})`);
  console.log(`Supply escrow:   ${supply.escrow != null ? (supply.escrow / 1e9).toFixed(2) + 'B XRP' : 'N/A'} (${supply.source})`);
  console.log(`XRPL DEX vol:    $${xrpl_metrics.dex_volume_24h_usd != null ? (xrpl_metrics.dex_volume_24h_usd / 1e6).toFixed(1) + 'M' : 'N/A'} | ${xrpl_metrics.dex_exchanges_24h ?? 'N/A'} trades | avg ${xrpl_metrics.avg_tx_per_ledger ?? 'N/A'} tx/ledger (${xrpl_metrics.source})`);
  console.log('───────────────────────────────────────────────\n');

  await pushToGitHub();

  console.log(`\nDone: ${new Date().toISOString()}`);
}

main().catch(e => {
  console.error('\nFATAL:', e);
  process.exit(1);
});
