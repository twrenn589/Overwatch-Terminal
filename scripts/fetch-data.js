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
    const data = await fetchJSON(ENDPOINTS.xrp);
    const r = data?.ripple;
    if (!r) throw new Error('Unexpected response shape');
    const result = {
      price:      r.usd              ?? null,
      change_24h: r.usd_24h_change   ?? null,
      volume_24h: r.usd_24h_vol      ?? null,
      market_cap: r.usd_market_cap   ?? null,
    };
    log('XRP', `price=$${result.price}  24h=${result.change_24h?.toFixed(2)}%`);
    return result;
  } catch (e) {
    err('XRP', e.message);
    return fallback?.xrp ?? { price: null, change_24h: null, volume_24h: null, market_cap: null };
  }
}

async function fetchRLUSD(fallback) {
  await sleep(COINGECKO_DELAY_MS);
  try {
    const data = await fetchJSON(ENDPOINTS.rlusd);
    const r = data?.['ripple-usd'];
    if (!r) throw new Error('Unexpected response shape — will try search');
    const result = { market_cap: r.usd_market_cap ?? null, source: 'coingecko' };
    log('RLUSD', `market_cap=$${result.market_cap?.toLocaleString()}`);
    return result;
  } catch (e) {
    warn('RLUSD', `Primary ID failed (${e.message}), trying search…`);
    try {
      await sleep(COINGECKO_DELAY_MS);
      const search = await fetchJSON(ENDPOINTS.rlusd_search);
      const coin = search?.coins?.find(c => c.symbol?.toUpperCase() === 'RLUSD');
      if (!coin) throw new Error('RLUSD not found in search results');
      // Fetch by the discovered id
      await sleep(COINGECKO_DELAY_MS);
      const data2 = await fetchJSON(
        `https://api.coingecko.com/api/v3/simple/price?ids=${coin.id}&vs_currencies=usd&include_market_cap=true`
      );
      const r2 = data2?.[coin.id];
      const result = { market_cap: r2?.usd_market_cap ?? null, source: 'coingecko' };
      log('RLUSD', `market_cap=$${result.market_cap?.toLocaleString()} (via search id=${coin.id})`);
      return result;
    } catch (e2) {
      err('RLUSD', e2.message);
      return fallback?.rlusd ?? { market_cap: null, source: 'manual' };
    }
  }
}

async function fetchFearGreed(fallback) {
  try {
    const data = await fetchJSON(ENDPOINTS.fear_greed);
    const entry = data?.data?.[0];
    if (!entry) throw new Error('Unexpected response shape');
    const result = {
      value: Number(entry.value),
      label: entry.value_classification,
    };
    log('Fear&Greed', `${result.value} — ${result.label}`);
    return result;
  } catch (e) {
    err('Fear&Greed', e.message);
    return fallback?.macro?.fear_greed ?? { value: null, label: null };
  }
}

async function fetchUSDJPY(fallback) {
  try {
    const data = await fetchJSON(ENDPOINTS.usd_jpy);
    const rate = data?.rates?.JPY;
    if (!rate) throw new Error('Unexpected response shape');
    log('USD/JPY', rate);
    return rate;
  } catch (e) {
    err('USD/JPY', e.message);
    return fallback?.macro?.usd_jpy ?? null;
  }
}

/**
 * Fetch a single FRED series. Returns the most recent non-null observation value.
 */
async function fetchFRED(seriesLabel, url, fallbackValue) {
  const key = process.env.FRED_API_KEY;
  if (!key) {
    warn('FRED', `FRED_API_KEY not set — skipping ${seriesLabel}`);
    return fallbackValue ?? null;
  }
  try {
    const fullUrl = `${url}&api_key=${encodeURIComponent(key)}`;
    const data = await fetchJSON(fullUrl);
    // FRED returns observations newest-first; find the first with a real value
    const obs = data?.observations?.find(o => o.value !== '.' && o.value !== '');
    if (!obs) throw new Error('No valid observation in response');
    const value = parseFloat(obs.value);
    log('FRED', `${seriesLabel} = ${value} (date: ${obs.date})`);
    return value;
  } catch (e) {
    err('FRED', `${seriesLabel}: ${e.message}`);
    return fallbackValue ?? null;
  }
}

// ─── ETF fetcher ──────────────────────────────────────────────────────────────

/**
 * Fetch XRP ETF data from xrp-insights.com's internal API.
 * Returns total AUM, total XRP locked, daily flows, and per-fund breakdown.
 * Always returns an "etf" object — never throws.
 */
async function fetchETF(fallback) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch('https://xrp-insights.com/api/flows?days=14', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Overwatch-Terminal/1.0)',
        'Accept':     'application/json',
        'Referer':    'https://xrp-insights.com/',
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();

    if (!data?.success || !Array.isArray(data?.daily) || data.daily.length === 0) {
      throw new Error('Unexpected response shape from xrp-insights API');
    }

    // Sort newest-first
    const sorted = [...data.daily].sort((a, b) => b.date.localeCompare(a.date));
    const latest = sorted[0];

    // Most recent day with actual flow data (skip weekends / zero-flow days)
    const latestWithFlow = sorted.find(d => d.inflow !== 0 || d.outflow !== 0) ?? latest;

    const funds = (latest.etfFlows ?? []).map(f => ({
      ticker:     f.ticker,
      issuer:     f.issuer,
      aum:        f.aum        ?? null,
      xrp_locked: f.xrpHoldings ?? null,
      daily_flow: f.flow       ?? null,
    }));

    const result = {
      last_fetched:     new Date().toISOString(),
      source:           'xrp-insights',
      as_of_date:       latest.date,
      total_aum:        latest.totalAUM        ?? null,
      total_xrp_locked: latest.totalXRP        ?? null,
      daily_net_flow:   latestWithFlow.netFlow  ?? null,
      daily_inflow:     latestWithFlow.inflow   ?? null,
      daily_outflow:    latestWithFlow.outflow  ?? null,
      flow_date:        latestWithFlow.date     ?? null,
      funds,
    };

    log('ETF', `AUM=$${(result.total_aum / 1e6).toFixed(1)}M | XRP=${(result.total_xrp_locked / 1e6).toFixed(0)}M | funds=${funds.length} | flow=${latestWithFlow.date}`);
    return result;
  } catch (e) {
    err('ETF', e.message);
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
  } finally {
    clearTimeout(timer);
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
      const data = await fetchJSON(cpUrl, 12_000);
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
      const ndUrl = `https://newsdata.io/api/1/news?apikey=${encodeURIComponent(ndKey)}&q=XRP%20OR%20Ripple%20OR%20XRPL&language=en&size=10`;
      const data = await fetchJSON(ndUrl, 12_000);
      const results = data?.results;
      if (!Array.isArray(results) || results.length === 0) throw new Error('Empty NewsData.io response');

      const headlines = results.slice(0, 15).map(p => ({
        title:     p.title ?? '',
        source:    p.source_id ?? 'NewsData',
        url:       p.link ?? '',
        published: p.pubDate ?? null,
      }));

      log('News', `NewsData.io: ${headlines.length} headlines`);
      return { last_fetched: new Date().toISOString(), source: 'newsdata', headlines };
    } catch (e2) {
      err('News', `NewsData.io also failed: ${e2.message}`);
    }
  } else {
    warn('News', 'NEWSDATA_API_KEY not set — no fallback available');
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
  const [xrp, rlusd, fearGreed, usdJpy, news, etf] = await Promise.all([
    fetchXRP(existing),
    fetchRLUSD(existing),
    fetchFearGreed(existing),
    fetchUSDJPY(existing),
    fetchNews(existing),
    fetchETF(existing),
  ]);

  // FRED calls are sequential to avoid hammering the API
  const jpn10y = await fetchFRED('JPN_10Y', ENDPOINTS.fred.jpn_10y, existing?.macro?.jpn_10y);
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
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  log('io', `Wrote ${OUTPUT_PATH}`);

  console.log('\n─── Summary ───────────────────────────────────');
  console.log(`XRP price:       $${xrp.price ?? 'N/A'}`);
  console.log(`RLUSD mktcap:    $${rlusd.market_cap?.toLocaleString() ?? 'N/A'} (${rlusd.source})`);
  console.log(`USD/JPY:         ${usdJpy ?? 'N/A'}`);
  console.log(`JPN 10Y yield:   ${jpn10y ?? 'N/A'}%`);
  console.log(`US 10Y yield:    ${us10y ?? 'N/A'}%`);
  console.log(`Brent crude:     $${brent ?? 'N/A'}`);
  console.log(`Fear & Greed:    ${fearGreed.value ?? 'N/A'} (${fearGreed.label ?? 'N/A'})`);
  console.log(`ETF total AUM:   $${etf.total_aum != null ? (etf.total_aum / 1e6).toFixed(1) + 'M' : 'N/A'} | XRP locked: ${etf.total_xrp_locked != null ? (etf.total_xrp_locked / 1e6).toFixed(0) + 'M' : 'N/A'} (${etf.source})`);
  console.log(`News headlines:  ${news.headlines.length} (source: ${news.source})`);
  console.log('───────────────────────────────────────────────\n');

  await pushToGitHub();

  console.log(`\nDone: ${new Date().toISOString()}`);
}

main().catch(e => {
  console.error('\nFATAL:', e);
  process.exit(1);
});
