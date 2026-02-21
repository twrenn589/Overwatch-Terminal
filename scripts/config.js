'use strict';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const FRED_BASE      = 'https://api.stlouisfed.org/fred/series/observations';

const ENDPOINTS = {
  xrp: `${COINGECKO_BASE}/simple/price?ids=ripple&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true&include_market_cap=true`,
  rlusd: `${COINGECKO_BASE}/simple/price?ids=ripple-usd&vs_currencies=usd&include_market_cap=true`,
  rlusd_search: `${COINGECKO_BASE}/search?query=RLUSD`,
  fear_greed: 'https://api.alternative.me/fng/?limit=1',
  usd_jpy: 'https://api.frankfurter.app/latest?from=USD&to=JPY',
  fred: {
    jpn_10y:    `${FRED_BASE}?series_id=IRLTLT01JPM156N&file_type=json&sort_order=desc&limit=1`,
    brent:      `${FRED_BASE}?series_id=DCOILBRENTEU&file_type=json&sort_order=desc&limit=1`,
    us_10y:     `${FRED_BASE}?series_id=DGS10&file_type=json&sort_order=desc&limit=1`,
  },
};

// Millisecond delay between CoinGecko calls to stay inside free-tier rate limits
const COINGECKO_DELAY_MS = 1200;

// Kill-switch targets — update these manually if goals change
const KILL_SWITCH_TARGETS = {
  odl_volume: {
    target:   25_000_000_000,
    deadline: '2026-12-31',
  },
  rlusd_circulation: {
    target:   5_000_000_000,
    deadline: '2026-12-31',
  },
  xrp_etf_aum: {
    target:   5_000_000_000,
    deadline: '2026-12-31',
  },
  permissioned_dex_adoption: {
    target_institutions: 5,
    deadline:            '2026-09-30',
  },
  clarity_act: {
    target:   'passed_or_advanced',
    deadline: '2026-12-31',
  },
};

module.exports = { ENDPOINTS, COINGECKO_DELAY_MS, KILL_SWITCH_TARGETS };
