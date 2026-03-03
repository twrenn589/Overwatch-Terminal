'use strict';

const path = require('path');
const fs   = require('fs');

function log(label, msg)  { console.log(`[${label}] ${msg}`); }
function err(label, msg)  { console.error(`[${label}] ERROR: ${msg}`); }

function promoteRejections() {
  const rejLogPath = path.join(__dirname, '..', 'data', 'rejection-log.json');
  const ledgerPath = path.join(__dirname, '..', 'data', 'corrections-ledger.json');

  if (!fs.existsSync(rejLogPath)) {
    log('promote', 'No rejection log found — nothing to promote');
    return 0;
  }

  const rejections = JSON.parse(fs.readFileSync(rejLogPath, 'utf8'));
  const promotable = rejections.filter(r => r.corrections_ledger_action === 'auto_commit' && !r.promoted);

  if (promotable.length === 0) {
    log('promote', 'No unpromoted auto_commit entries found');
    return 0;
  }

  let ledger = [];
  if (fs.existsSync(ledgerPath)) {
    const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    if (Array.isArray(raw)) ledger = raw;
  }

  const existingIds = ledger.map(e => parseInt(e.id?.replace('CL-', ''), 10) || 0);
  let nextId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1;

  const newCorrections = promotable.map(r => {
    const entry = {
      id: `CL-${String(nextId).padStart(3, '0')}`,
      date_of_error: r.timestamp ? r.timestamp.split('T')[0] : new Date().toISOString().split('T')[0],
      date_identified: new Date().toISOString().split('T')[0],
      identified_by: 'layer_4_override',
      belief: r.layer3_inference || 'Unknown inference',
      reality: r.rejection_reason || 'Unknown rejection reason',
      root_cause: r.rejection_reason || '',
      root_cause_type: r.root_cause || 'ASSUMPTION_FAILURE',
      prevention: 'NEEDS_ENRICHMENT',
      lesson: 'NEEDS_ENRICHMENT',
      trigger: 'NEEDS_ENRICHMENT',
      lesson_type: 'NEEDS_ENRICHMENT',
      confidence_in_lesson: (r.confidence_in_rejection || 'medium').toUpperCase(),
      times_applied: 0,
      times_applicable_but_missed: 0,
      status: 'ACTIVE'
    };
    nextId++;
    return entry;
  });

  ledger.push(...newCorrections);
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

  for (const r of rejections) {
    if (r.corrections_ledger_action === 'auto_commit' && !r.promoted) {
      r.promoted = true;
      r.promoted_at = new Date().toISOString();
    }
  }
  fs.writeFileSync(rejLogPath, JSON.stringify(rejections, null, 2));

  log('promote', `Promoted ${newCorrections.length} entries (${newCorrections.map(c => c.id).join(', ')})`);
  return newCorrections.length;
}

module.exports = promoteRejections;

if (require.main === module) {
  promoteRejections();
}
