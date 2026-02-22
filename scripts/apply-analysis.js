#!/usr/bin/env node
'use strict';

/**
 * Overwatch Terminal — Apply Approved Analysis
 * Reads analysis-output.json and applies recommended scorecard and kill-switch
 * updates to dashboard-data.json.
 * Run this after reviewing the Telegram analysis and deciding to approve.
 */

const path = require('path');
const fs   = require('fs');

const DASHBOARD_PATH       = path.join(__dirname, '..', 'dashboard-data.json');
const DASHBOARD_BACKUP     = path.join(__dirname, '..', 'dashboard-data.backup.json');
const ANALYSIS_PATH        = path.join(__dirname, '..', 'analysis-output.json');
const INDEX_PATH           = path.join(__dirname, '..', 'index.html');
const INDEX_BACKUP         = path.join(__dirname, '..', 'index.backup.html');
const EVENTS_LOG_PATH      = path.join(__dirname, 'events-history.json');
const CHANGELOG_PATH       = path.join(__dirname, 'changelog.log');

// ─── Utilities ────────────────────────────────────────────────────────────────

function log(label, msg)  { console.log(`[${label}] ${msg}`); }
function warn(label, msg) { console.warn(`[${label}] WARN: ${msg}`); }
function err(label, msg)  { console.error(`[${label}] ERROR: ${msg}`); }

// ─── Backup / Restore helpers ─────────────────────────────────────────────────

function backupFile(src, dest) {
  try {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      log('backup', `${path.basename(src)} → ${path.basename(dest)}`);
    }
  } catch (e) {
    warn('backup', `Could not back up ${path.basename(src)}: ${e.message}`);
  }
}

function restoreFile(backup, dest) {
  try {
    if (fs.existsSync(backup)) {
      fs.copyFileSync(backup, dest);
      warn('restore', `Restored ${path.basename(dest)} from backup`);
    }
  } catch (e) {
    err('restore', `Could not restore ${path.basename(dest)}: ${e.message}`);
  }
}

// ─── Changelog ────────────────────────────────────────────────────────────────

function appendChangelog(entries) {
  if (entries.length === 0) return;
  const ts = new Date().toISOString();
  const lines = [`\n--- ${ts} ---`, ...entries];
  try {
    fs.appendFileSync(CHANGELOG_PATH, lines.join('\n') + '\n');
    log('changelog', `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} written`);
  } catch (e) {
    warn('changelog', `Could not write changelog: ${e.message}`);
  }
}

// ─── Qualitative HTML update helpers ─────────────────────────────────────────

/**
 * Replace the content of a <p id="ELEMENT_ID">...</p> in html string.
 * Returns { html, changed } — changed=true if the content was actually different.
 */
function replaceParaById(html, elementId, newText) {
  if (!newText || typeof newText !== 'string') return { html, changed: false };
  const re = new RegExp(`(<p\\s[^>]*id="${elementId}"[^>]*>)([^<]*)(</p>)`, 's');
  const match = html.match(re);
  if (!match) {
    warn('html', `Element id="${elementId}" not found in index.html`);
    return { html, changed: false };
  }
  const existing = match[2].trim();
  const incoming = newText.trim();
  // Skip if text is identical or very similar (first 60 chars match)
  if (existing === incoming || existing.substring(0, 60) === incoming.substring(0, 60)) {
    return { html, changed: false };
  }
  return { html: html.replace(re, `$1${incoming}$3`), changed: true };
}

/**
 * Replace the inner HTML of <div id="geoWatchlist">...</div> with new rows.
 * newRows: [{region, status_text}]
 */
function replaceGeoWatchlist(html, newRows) {
  if (!Array.isArray(newRows) || newRows.length === 0) return { html, changed: false };
  const startTag = '<div id="geoWatchlist">';
  const startIdx = html.indexOf(startTag);
  if (startIdx === -1) {
    warn('html', 'Element id="geoWatchlist" not found in index.html');
    return { html, changed: false };
  }
  // Find closing </div>
  const contentStart = startIdx + startTag.length;
  let depth = 1;
  let i = contentStart;
  while (i < html.length && depth > 0) {
    if (html.startsWith('<div', i)) depth++;
    else if (html.startsWith('</div>', i)) { depth--; if (depth === 0) break; }
    i++;
  }
  const existing = html.substring(contentStart, i);
  const newContent = '\n' + newRows.map(r => {
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `        <div class="data-row"><span class="data-label">${esc(r.region)}</span><span class="signal amber">${esc(r.status_text)}</span></div>`;
  }).join('\n') + '\n      ';
  if (existing.trim() === newContent.trim()) return { html, changed: false };
  const updatedHtml = html.substring(0, contentStart) + newContent + html.substring(i);
  return { html: updatedHtml, changed: true };
}

// Map from Claude's scorecard category label → dashboard-data.json thesis_scores key
const SCORE_KEY_MAP = {
  'Regulatory Clarity':   'regulatory',
  'Regulatory':           'regulatory',
  'Institutional Custody': 'institutional_custody',
  'ETF Adoption':         'etf_adoption',
  'XRPL Infrastructure':  'xrpl_infrastructure',
  'Stablecoin (RLUSD)':   'stablecoin_adoption',
  'Stablecoin Adoption':  'stablecoin_adoption',
  'RLUSD':                'stablecoin_adoption',
  'ODL Volume':           'odl_volume',
  'Japan Adoption':       'japan_adoption',
  'Macro Environment':    'macro_environment',
  'Macro':                'macro_environment',
};

// Map from Claude's kill switch name → dashboard-data.json kill_switches key
const KS_KEY_MAP = {
  'ODL Volume':                   'odl_volume',
  'RLUSD Circulation':            'rlusd_circulation',
  'Permissioned DEX':             'permissioned_dex_adoption',
  'XRP ETF AUM':                  'xrp_etf_aum',
  'Japan Adoption':               'japan_adoption',
  'Clarity Act':                  'clarity_act',
  'Announcement-to-Deployment':   'announcement_to_deployment',
  'Token Velocity':               'token_velocity',
  'Competitive Displacement':     'competitive_displacement',
  'ODL Transparency':             'odl_transparency',
};

// ─── Events Timeline helpers ──────────────────────────────────────────────────

/** Slugify a title to ~40 chars for duplicate detection. */
function titleKey(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().substring(0, 40);
}

/** Load events-history.json (list of title keys already inserted). Returns a Set. */
function loadEventsHistory() {
  try {
    if (fs.existsSync(EVENTS_LOG_PATH)) {
      const data = JSON.parse(fs.readFileSync(EVENTS_LOG_PATH, 'utf8'));
      return new Set(Array.isArray(data) ? data : []);
    }
  } catch (e) {
    warn('events', `Could not read events-history.json: ${e.message}`);
  }
  return new Set();
}

/** Append new title keys to events-history.json. */
function saveEventsHistory(history) {
  try {
    fs.writeFileSync(EVENTS_LOG_PATH, JSON.stringify([...history], null, 2));
  } catch (e) {
    warn('events', `Could not write events-history.json: ${e.message}`);
  }
}

/** Map Claude severity → threat fields used in EVENTS_DATA. */
function mapSeverity(severity) {
  switch ((severity ?? '').toUpperCase()) {
    case 'CRITICAL':   return { threat: 'CRITICAL',   threatEmoji: '🔴' };
    case 'ELEVATED':   return { threat: 'ELEVATED',   threatEmoji: '🟡' };
    default:           return { threat: 'MONITORING', threatEmoji: '🟢' };
  }
}

/** Map Claude category → catClass used for CSS styling. */
function mapCategory(category) {
  switch ((category ?? '').toUpperCase()) {
    case 'INSTITUTIONAL': return 'inst';
    case 'REGULATORY':    return 'reg';
    case 'GEOPOLITICAL':  return 'geo';
    case 'FINANCIAL':     return 'fin';
    default:              return 'inst';
  }
}

/**
 * Parse a date label like "Feb 20" into a YYYY-MM-DD sort key.
 * Falls back to today's date if parsing fails.
 */
function parseDateLabel(label) {
  try {
    const d = new Date(`${label} ${new Date().getFullYear()}`);
    if (!isNaN(d.getTime())) {
      return {
        date:      d.toISOString().substring(0, 10),
        dateLabel: label.toUpperCase(),
      };
    }
  } catch (_) { /* fall through */ }
  const now = new Date();
  return {
    date:      now.toISOString().substring(0, 10),
    dateLabel: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase(),
  };
}

/** Build the JS object literal string for a single EVENTS_DATA entry. */
function buildEventEntry(evt) {
  const { date, dateLabel } = parseDateLabel(evt.date);
  const category = (evt.category ?? 'INSTITUTIONAL').toUpperCase();
  const catClass  = mapCategory(category);
  const { threat, threatEmoji } = mapSeverity(evt.severity);
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  return `  {
    date: '${date}',
    dateLabel: '${dateLabel}',
    title: '${esc(evt.title)}',
    category: '${category}',
    catClass: '${catClass}',
    threat: '${threat}',
    threatEmoji: '${threatEmoji}',
    desc: '${esc(evt.expanded ?? '')}'
  }`;
}

/**
 * Insert new events_draft entries into the EVENTS_DATA array in index.html.
 * Deduplicates against both existing HTML content and events-history.json.
 * Returns the count of newly inserted events.
 */
function insertEventsIntoHTML(eventsDraft) {
  if (!fs.existsSync(INDEX_PATH)) {
    err('events', 'index.html not found — cannot insert events');
    return 0;
  }

  let html = fs.readFileSync(INDEX_PATH, 'utf8');
  const history = loadEventsHistory();

  const markerStart = 'const EVENTS_DATA = [';
  const markerIdx = html.indexOf(markerStart);
  if (markerIdx === -1) {
    err('events', 'Could not find EVENTS_DATA array in index.html');
    return 0;
  }

  // Extract existing titles from html for in-file duplicate check
  const existingTitles = new Set();
  const titleRegex = /title:\s*'([^']+)'/g;
  let m;
  while ((m = titleRegex.exec(html)) !== null) {
    existingTitles.add(titleKey(m[1]));
  }

  let inserted = 0;
  const newEntries = [];

  for (const evt of eventsDraft) {
    if (!evt.title) continue;
    const key = titleKey(evt.title);

    if (existingTitles.has(key) || history.has(key)) {
      log('events', `Skipping duplicate: "${evt.title.substring(0, 50)}"`);
      continue;
    }

    newEntries.push(evt);
    history.add(key);
    existingTitles.add(key);
    inserted++;
  }

  if (inserted === 0) {
    log('events', 'All events already exist — no changes to index.html');
    return 0;
  }

  // New entries go at the TOP of EVENTS_DATA (newest first)
  const insertionBlock = newEntries.map(buildEventEntry).join(',\n') + ',\n';
  const insertionPoint = markerIdx + markerStart.length + 1; // after the '['

  html = html.substring(0, insertionPoint) + '\n' + insertionBlock + html.substring(insertionPoint);

  fs.writeFileSync(INDEX_PATH, html);
  log('events', `Wrote updated index.html (${inserted} new event${inserted === 1 ? '' : 's'})`);

  saveEventsHistory(history);
  return inserted;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n━━━ Overwatch Terminal — Apply Analysis ━━━');
  console.log(`Started: ${new Date().toISOString()}\n`);

  // 1. Load both files
  if (!fs.existsSync(ANALYSIS_PATH)) {
    err('io', 'analysis-output.json not found — run analyze-thesis.js first');
    process.exit(1);
  }
  if (!fs.existsSync(DASHBOARD_PATH)) {
    err('io', 'dashboard-data.json not found');
    process.exit(1);
  }

  const analysis  = JSON.parse(fs.readFileSync(ANALYSIS_PATH, 'utf8'));
  const dashboard = JSON.parse(fs.readFileSync(DASHBOARD_PATH, 'utf8'));

  log('io', `Loaded analysis from: ${analysis.timestamp ?? 'unknown'}`);
  log('io', 'Loaded dashboard-data.json');

  let changes = 0;
  const changelogEntries = [];

  // 1b. Backup files before any writes
  backupFile(DASHBOARD_PATH, DASHBOARD_BACKUP);
  backupFile(INDEX_PATH, INDEX_BACKUP);

  // 2. Apply scorecard updates
  const scorecardUpdates = analysis.scorecard_updates ?? [];
  for (const update of scorecardUpdates) {
    if (update.recommended_status === update.previous_status) continue;

    const key = SCORE_KEY_MAP[update.category];
    if (!key) {
      warn('scorecard', `Unknown category "${update.category}" — skipping`);
      continue;
    }

    if (!dashboard.thesis_scores) dashboard.thesis_scores = {};
    const current = dashboard.thesis_scores[key] ?? {};

    log('scorecard', `${update.category}: ${current.status ?? '?'} → ${update.recommended_status}`);
    dashboard.thesis_scores[key] = {
      ...current,
      status: update.recommended_status,
    };
    changelogEntries.push(`SCORECARD ${update.category}: ${current.status ?? '?'} → ${update.recommended_status}`);
    changes++;
  }

  // 3. Apply kill switch status notes (we update status field if changed)
  const ksUpdates = analysis.kill_switch_updates ?? [];
  for (const update of ksUpdates) {
    if (update.recommended_status === update.previous_status) continue;

    const key = KS_KEY_MAP[update.name];
    if (!key) {
      warn('kill_switch', `Unknown kill switch "${update.name}" — skipping`);
      continue;
    }

    if (!dashboard.kill_switches) dashboard.kill_switches = {};
    if (!dashboard.kill_switches[key]) {
      warn('kill_switch', `kill_switches.${key} not found in dashboard — skipping`);
      continue;
    }

    log('kill_switch', `${update.name}: ${update.previous_status} → ${update.recommended_status}`);
    dashboard.kill_switches[key].status = update.recommended_status;
    if (update.reasoning) {
      dashboard.kill_switches[key]._analysis_note = update.reasoning;
    }
    changelogEntries.push(`KILL_SWITCH ${update.name}: ${update.previous_status} → ${update.recommended_status}`);
    changes++;
  }

  // 4. Apply probability adjustment if recommended
  const prob = analysis.recommended_probability_adjustment;
  if (prob && prob.reasoning) {
    log('probability', `Applying recommended probability: Bear ${prob.bear}% | Base ${prob.base}% | Mid ${prob.mid}% | Bull ${prob.bull}%`);
    dashboard.probability = {
      bear: prob.bear,
      base: prob.base,
      mid:  prob.mid,
      bull: prob.bull,
      last_updated: analysis.timestamp,
      last_reasoning: prob.reasoning,
    };
    changelogEntries.push(`PROBABILITY: Bear ${prob.bear}% | Base ${prob.base}% | Mid ${prob.mid}% | Bull ${prob.bull}%`);
    changes++;
  }

  // 5. Stamp the applied analysis metadata
  dashboard.last_analysis = {
    timestamp:   analysis.timestamp,
    run_type:    analysis.run_type,
    stress_level: analysis.stress_assessment?.level,
    stress_score: analysis.stress_assessment?.score,
    applied_at:  new Date().toISOString(),
    changes_applied: changes,
  };

  // 6. Write updated dashboard-data.json (restore on failure)
  try {
    fs.writeFileSync(DASHBOARD_PATH, JSON.stringify(dashboard, null, 2));
    log('io', `Wrote dashboard-data.json (${changes} change${changes === 1 ? '' : 's'} applied)`);
  } catch (writeErr) {
    err('io', `Failed to write dashboard-data.json: ${writeErr.message}`);
    restoreFile(DASHBOARD_BACKUP, DASHBOARD_PATH);
    process.exit(1);
  }

  // 7. Insert events_draft entries into index.html Events Timeline
  const eventsDraft = analysis.events_draft ?? [];
  let eventsInserted = 0;
  if (eventsDraft.length > 0) {
    eventsInserted = insertEventsIntoHTML(eventsDraft);
    log('events', `${eventsInserted} new event(s) inserted into index.html`);
    if (eventsInserted > 0) {
      changelogEntries.push(`EVENTS: ${eventsInserted} new event(s) inserted into timeline`);
    }
    changes += eventsInserted;
  } else {
    log('events', 'No events_draft in analysis — skipping timeline update');
  }

  // 8. Apply qualitative text updates to index.html
  let htmlChanges = 0;
  if (fs.existsSync(INDEX_PATH)) {
    let html = fs.readFileSync(INDEX_PATH, 'utf8');
    let changed;

    // Thesis pulse assessment
    if (analysis.thesis_pulse_assessment) {
      ({ html, changed } = replaceParaById(html, 'thesisPulseText', analysis.thesis_pulse_assessment));
      if (changed) { log('html', 'Updated #thesisPulseText'); changelogEntries.push('HTML: thesis_pulse_assessment updated'); htmlChanges++; }
    }

    // Stress interpretation
    if (analysis.stress_interpretation) {
      ({ html, changed } = replaceParaById(html, 'stressInterpretText', analysis.stress_interpretation));
      if (changed) { log('html', 'Updated #stressInterpretText'); changelogEntries.push('HTML: stress_interpretation updated'); htmlChanges++; }
    }

    // Energy interpretation
    if (analysis.energy_interpretation) {
      ({ html, changed } = replaceParaById(html, 'energyInterpretText', analysis.energy_interpretation));
      if (changed) { log('html', 'Updated #energyInterpretText'); changelogEntries.push('HTML: energy_interpretation updated'); htmlChanges++; }
    }

    // Geopolitical watchlist
    if (Array.isArray(analysis.geopolitical_watchlist) && analysis.geopolitical_watchlist.length > 0) {
      ({ html, changed } = replaceGeoWatchlist(html, analysis.geopolitical_watchlist));
      if (changed) { log('html', 'Updated #geoWatchlist'); changelogEntries.push('HTML: geopolitical_watchlist updated'); htmlChanges++; }
    }

    if (htmlChanges > 0) {
      try {
        fs.writeFileSync(INDEX_PATH, html);
        log('html', `Wrote index.html (${htmlChanges} qualitative update${htmlChanges === 1 ? '' : 's'})`);
        changes += htmlChanges;
      } catch (writeErr) {
        err('html', `Failed to write index.html: ${writeErr.message}`);
        restoreFile(INDEX_BACKUP, INDEX_PATH);
      }
    } else {
      log('html', 'No qualitative text changes needed');
    }
  }

  // 9. Write changelog
  appendChangelog(changelogEntries);

  console.log('\n─── Apply Summary ──────────────────────────────');
  console.log(`Analysis timestamp: ${analysis.timestamp}`);
  console.log(`Changes applied:    ${changes}`);
  console.log(`Scorecard updates:  ${scorecardUpdates.filter(s => s.recommended_status !== s.previous_status).length}`);
  console.log(`Kill sw updates:    ${ksUpdates.filter(k => k.recommended_status !== k.previous_status).length}`);
  if (prob?.reasoning) console.log(`Probability:        Updated`);
  console.log(`Events inserted:    ${eventsInserted}`);
  console.log('───────────────────────────────────────────────\n');

  if (changes === 0) {
    warn('apply', 'No changes to apply — all recommendations matched existing state');
  }

  console.log(`Done: ${new Date().toISOString()}`);
}

main().catch(e => {
  console.error('\nFATAL:', e);
  process.exit(1);
});
