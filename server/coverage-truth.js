'use strict';

// Historical achievement and present usability deliberately answer different questions.
function coverageTruth(rows = [], { now = Date.now(), maxAgeMs = 36 * 60 * 60 * 1000 } = {}) {
  const counts = { historicalVerified: 0, currentUsable: 0, technicalUsable: 0, stale: 0, pending: 0, partial: 0, quarantined: 0, suspect: 0, temporaryFailed: 0 };
  for (const row of rows) {
    const historical = Boolean(row.last_verified_at || row.status === 'verified' && row.symbol_verified && row.chart_ready);
    if (historical) counts.historicalVerified += 1;
    if (row.active === false) continue;
    if (row.status === 'partial') counts.partial += 1;
    const age = Number(now) - Date.parse(row.last_checked_at || '');
    const fresh = Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
    if (row.guard_status === 'quarantined') counts.quarantined += 1;
    else if (row.guard_status === 'suspect') counts.suspect += 1;
    else if (row.status === 'temporary_failed') counts.temporaryFailed += 1;
    else if (row.status === 'pending') counts.pending += 1;
    else if (historical && (!fresh || row.guard_status === 'stale')) counts.stale += 1;
    const usable = fresh && row.status === 'verified' && ['accepted', 'delayed'].includes(row.guard_status)
      && row.symbol_verified === true && row.chart_ready === true;
    if (usable) {
      counts.currentUsable += 1;
      if (row.technical_ready === true) counts.technicalUsable += 1;
    }
  }
  return counts;
}

module.exports = { coverageTruth };
