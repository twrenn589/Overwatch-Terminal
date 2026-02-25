#!/usr/bin/env node
'use strict';

/**
 * Overwatch Terminal — x402 Merchant Server (XRPL mainnet)
 *
 * Three paywalled endpoints, each with independent pricing:
 *
 *   GET /api/v1/premium-analysis  1000 drops  — full thesis scorecard + market snapshot
 *   GET /api/v1/bear-case         1500 drops  — counter-thesis, competing infra, macro headwinds
 *   GET /api/v1/stress-report      500 drops  — stress indicators, macro data, kill switch status
 *   GET /health                    free        — server status
 *
 * x402 flow per endpoint:
 *   1. No PAYMENT-SIGNATURE → 402 + PAYMENT-REQUIRED header (base64 JSON)
 *   2. Retry with PAYMENT-SIGNATURE → server calls T54 /verify then /settle
 *   3. Settlement confirmed → 200 + data + PAYMENT-RESPONSE header
 *
 * Required env vars (scripts/.env):
 *   XRPL_MERCHANT_ADDRESS   — mainnet XRP address to receive payments
 *   XRPL_FACILITATOR_URL    — T54 facilitator (default: mainnet)
 */

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');

// ─── Config ────────────────────────────────────────────────────────────────

const MERCHANT_ADDRESS = process.env.XRPL_MERCHANT_ADDRESS;
if (!MERCHANT_ADDRESS) {
  console.error('[merchant] FATAL: XRPL_MERCHANT_ADDRESS is required — add it to scripts/.env');
  process.exit(1);
}

const FACILITATOR_URL  = process.env.XRPL_FACILITATOR_URL ?? 'https://xrpl-facilitator-mainnet.t54.ai';
const NETWORK          = process.env.XRPL_NETWORK         ?? 'xrpl:0';
const PORT             = Number(process.env.MERCHANT_PORT  ?? process.env.PORT ?? '4403');
const DATA_FILE        = path.join(__dirname, '..', 'dashboard-data.json');

const X402_VERSION     = 2;
const SOURCE_TAG       = 804681468;
const MAX_TIMEOUT_SECS = 300;

// ─── Logging ───────────────────────────────────────────────────────────────

function log(msg)  { console.log(`[merchant] ${msg}`); }
function warn(msg) { console.warn(`[merchant] WARN: ${msg}`); }
function err(msg)  { console.error(`[merchant] ERROR: ${msg}`); }

// ─── x402 Header Codec ─────────────────────────────────────────────────────

function canonicalJSON(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalJSON).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(obj[k])).join(',') + '}';
}

function encodeX402Header(obj) {
  return Buffer.from(canonicalJSON(obj), 'utf8').toString('base64');
}

function decodeX402Header(b64) {
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

// ─── Data helpers ───────────────────────────────────────────────────────────

function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    warn(`Could not read dashboard-data.json: ${e.message}`);
    return {};
  }
}

// ─── Payload builders ──────────────────────────────────────────────────────

function buildAnalysisPayload() {
  const raw = readData();
  return {
    resource:  'premium-analysis',
    timestamp: new Date().toISOString(),
    data: {
      probability:   raw.probability     ?? null,
      thesis_scores: raw.thesis_scores   ?? null,
      kill_switches: raw.kill_switches   ?? null,
      last_analysis: raw.last_analysis   ?? null,
      market: {
        xrp_price_usd:      raw.xrp?.price             ?? null,
        xrp_change_24h_pct: raw.xrp?.change_24h        ?? null,
        fear_greed:         raw.macro?.fear_greed       ?? null,
        rlusd_market_cap:   raw.rlusd?.market_cap       ?? null,
        etf_total_aum:      raw.etf?.total_aum          ?? null,
        etf_daily_flow:     raw.etf?.daily_net_flow     ?? null,
        etf_cum_flow:       raw.etf?.cum_net_flow       ?? null,
        us_10y:             raw.macro?.us_10y_yield     ?? null,
        brent_crude:        raw.macro?.brent_crude      ?? null,
        usd_jpy:            raw.macro?.usd_jpy          ?? null,
      },
      data_as_of: raw.updated ?? null,
    },
  };
}

function buildBearCasePayload() {
  const raw = readData();
  const bc  = raw.bear_case ?? {};
  return {
    resource:  'bear-case',
    timestamp: new Date().toISOString(),
    data: {
      counter_thesis_score:    bc.counter_thesis_score    ?? null,
      score_reasoning:         bc.score_reasoning         ?? null,
      bear_narrative:          bc.bear_narrative          ?? null,
      competing_infrastructure: bc.competing_infrastructure ?? [],
      macro_headwinds:         bc.macro_headwinds         ?? [],
      odl_stagnation:          bc.odl_stagnation          ?? null,
      token_velocity_concern:  bc.token_velocity_concern  ?? null,
      kill_switches:           raw.kill_switches          ?? null,
      last_updated:            bc.last_updated            ?? null,
      data_as_of:              raw.updated                ?? null,
    },
  };
}

function buildStressPayload() {
  const raw = readData();
  const bc  = raw.bear_case ?? {};
  return {
    resource:  'stress-report',
    timestamp: new Date().toISOString(),
    data: {
      stress_assessment: raw.stress_assessment ?? null,
      bear_score:        bc.counter_thesis_score ?? null,
      macro: {
        usd_jpy:     raw.macro?.usd_jpy      ?? null,
        jpn_10y:     raw.macro?.jpn_10y      ?? null,
        us_10y:      raw.macro?.us_10y_yield ?? null,
        brent_crude: raw.macro?.brent_crude  ?? null,
        fear_greed:  raw.macro?.fear_greed   ?? null,
      },
      macro_headwinds:  bc.macro_headwinds   ?? [],
      xrpl_metrics:     raw.xrpl_metrics     ?? null,
      kill_switches:    raw.kill_switches    ?? null,
      data_as_of:       raw.updated          ?? null,
    },
  };
}

// ─── Invoice store ─────────────────────────────────────────────────────────

// Shared across all endpoints — invoiceIds are UUIDs so no collision risk.
const pendingInvoices = new Map();

// ─── Paywall route factory ──────────────────────────────────────────────────

/**
 * Returns an async Express route handler that implements the full x402 flow
 * for a given price and data builder.
 *
 * @param {string}   routePath    — e.g. '/api/v1/bear-case'
 * @param {string}   priceDrops   — price in XRP drops as a string
 * @param {string}   description  — human-readable description for 402 body
 * @param {Function} buildPayload — () => object  — called after payment to build response
 */
function makePaywallRoute(routePath, priceDrops, description, buildPayload) {
  return async (req, res) => {
    const paymentSig = req.headers['payment-signature'];

    // ── No payment: issue 402 ─────────────────────────────────────────────
    if (!paymentSig) {
      const invoiceId = crypto.randomUUID().replace(/-/g, '').toUpperCase();

      const requirements = {
        scheme:            'exact',
        network:           NETWORK,
        amount:            priceDrops,
        asset:             'XRP',
        payTo:             MERCHANT_ADDRESS,
        maxTimeoutSeconds: MAX_TIMEOUT_SECS,
        extra:             { invoiceId, sourceTag: SOURCE_TAG },
      };

      pendingInvoices.set(invoiceId, requirements);
      setTimeout(() => pendingInvoices.delete(invoiceId), 600_000);

      const body402 = {
        x402Version: X402_VERSION,
        resource: {
          url:         `${req.protocol}://${req.get('host')}${routePath}`,
          description,
          mimeType:    'application/json',
        },
        accepts:    [requirements],
        error:      'Payment required — retry with PAYMENT-SIGNATURE header',
        extensions: {},
      };

      log(`402 [${routePath}] invoiceId=${invoiceId.slice(0, 12)}… amount=${priceDrops} drops`);
      res.set('PAYMENT-REQUIRED', encodeX402Header(body402));
      return res.status(402).json(body402);
    }

    // ── Has payment signature: decode → verify → settle ───────────────────
    let sigObj;
    try {
      sigObj = decodeX402Header(paymentSig);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid PAYMENT-SIGNATURE encoding' });
    }

    const invoiceId    = sigObj.payload?.invoiceId;
    const requirements = pendingInvoices.get(invoiceId);

    if (!requirements) {
      log(`Unknown or expired invoiceId: ${invoiceId} [${routePath}]`);
      return res.status(402).json({ error: 'Unknown or expired invoice — send a new request' });
    }

    try {
      // Verify
      log(`/verify [${routePath}] invoice=${invoiceId.slice(0, 12)}…`);
      const verifyRes = await fetch(`${FACILITATOR_URL}/verify`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ paymentPayload: sigObj, paymentRequirements: requirements }),
        signal:  AbortSignal.timeout(15_000),
      });

      if (!verifyRes.ok) {
        const text = await verifyRes.text().catch(() => '');
        err(`/verify HTTP ${verifyRes.status}: ${text}`);
        return res.status(402).json({ error: `Facilitator verify failed (HTTP ${verifyRes.status})` });
      }

      const verification = await verifyRes.json();
      if (!verification.isValid) {
        log(`/verify rejected: ${verification.invalidReason}`);
        return res.status(402).json({ error: verification.invalidReason ?? 'Payment verification failed' });
      }

      // Settle
      log(`/settle [${routePath}] invoice=${invoiceId.slice(0, 12)}…`);
      const settleRes = await fetch(`${FACILITATOR_URL}/settle`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ paymentPayload: sigObj, paymentRequirements: requirements }),
        signal:  AbortSignal.timeout(30_000),
      });

      if (!settleRes.ok) {
        const text = await settleRes.text().catch(() => '');
        err(`/settle HTTP ${settleRes.status}: ${text}`);
        return res.status(402).json({ error: `Facilitator settle failed (HTTP ${settleRes.status})` });
      }

      const settlement = await settleRes.json();
      log(`/settle: success=${settlement.success} tx=${settlement.transaction ?? 'n/a'} [${routePath}]`);

      if (!settlement.success) {
        return res.status(402).json({ error: settlement.errorReason ?? 'Settlement failed' });
      }

      pendingInvoices.delete(invoiceId);

      const payload = buildPayload();
      payload.access  = 'GRANTED';
      payload.payment = {
        protocol:     'x402',
        version:      X402_VERSION,
        tx_hash:      settlement.transaction,
        payer:        settlement.payer,
        amount_drops: priceDrops,
        amount_xrp:   (parseInt(priceDrops, 10) / 1_000_000).toFixed(6),
        network:      settlement.network ?? NETWORK,
        facilitator:  FACILITATOR_URL,
      };

      res.set('PAYMENT-RESPONSE', encodeX402Header({
        success:     true,
        transaction: settlement.transaction,
        network:     settlement.network ?? NETWORK,
        payer:       settlement.payer,
      }));

      log(`200 [${routePath}] payer=${settlement.payer?.slice(0, 10)}… tx=${settlement.transaction?.slice(0, 12)}…`);
      return res.status(200).json(payload);

    } catch (e) {
      if (e.name === 'TimeoutError') {
        err(`Facilitator timeout [${routePath}]: ${e.message}`);
        return res.status(502).json({ error: 'Facilitator timed out — try again' });
      }
      err(`Facilitator error [${routePath}]: ${e.message}`);
      return res.status(500).json({ error: 'Internal error — try again' });
    }
  };
}

// ─── Express app ───────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// ── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:      'ok',
    network:     NETWORK,
    facilitator: FACILITATOR_URL,
    merchant:    MERCHANT_ADDRESS,
    endpoints: [
      { path: '/api/v1/premium-analysis', drops: '1000', xrp: '0.001000' },
      { path: '/api/v1/bear-case',        drops: '1500', xrp: '0.001500' },
      { path: '/api/v1/stress-report',    drops:  '500', xrp: '0.000500' },
    ],
  });
});

// ── Paywalled endpoints ─────────────────────────────────────────────────────
app.get('/api/v1/premium-analysis', makePaywallRoute(
  '/api/v1/premium-analysis',
  '1000',
  'Overwatch Terminal — Premium Thesis Analysis (XRPL mainnet)',
  buildAnalysisPayload,
));

app.get('/api/v1/bear-case', makePaywallRoute(
  '/api/v1/bear-case',
  '1500',
  'Overwatch Terminal — Counter-Thesis & Bear Case (XRPL mainnet)',
  buildBearCasePayload,
));

app.get('/api/v1/stress-report', makePaywallRoute(
  '/api/v1/stress-report',
  '500',
  'Overwatch Terminal — Macro Stress Report (XRPL mainnet)',
  buildStressPayload,
));

// ─── Start ─────────────────────────────────────────────────────────────────

app.listen(PORT, '127.0.0.1', () => {
  console.log('\n━━━ Overwatch x402 Merchant Server (XRPL mainnet) ━━━');
  log(`Listening on   http://127.0.0.1:${PORT}`);
  log(`Network:       ${NETWORK}  |  Facilitator: ${FACILITATOR_URL}`);
  log(`Merchant:      ${MERCHANT_ADDRESS}`);
  log(`Endpoints:`);
  log(`  1000 drops  →  GET /api/v1/premium-analysis`);
  log(`  1500 drops  →  GET /api/v1/bear-case`);
  log(`   500 drops  →  GET /api/v1/stress-report`);
  console.log('');
});
