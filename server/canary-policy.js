'use strict';
const { stopped } = require('./controlled-coverage-store');
const SYMBOLS = Object.freeze(['PTT','SCB','ADVANC','BOL','NETBAY']);
// One durable identity across workflow retries, tags and calendar days.
const RUN_KEY = 'v156:coverage:2026-10-26:canary-5';
function selectCanary(rows) {
  if (!Array.isArray(rows) || new Set(rows.map(r=>r.symbol)).size!==rows.length) throw stopped('CANARY_MAPPING_INVALID');
  return SYMBOLS.map(symbol=>{
    const row=rows.find(r=>r.symbol===symbol);
    if (!row || row.provider_symbol!==symbol+'.BK' || row.provider!=='Yahoo Finance' || row.active!==true
      || row.status!=='verified' || row.symbol_verified!==true || row.chart_ready!==true || row.technical_ready!==true
      || !['accepted','delayed'].includes(row.guard_status)) throw stopped('CANARY_PREFLIGHT_FAILED');
    return row;
  });
}
function counts(rows) {
  return {total:rows.length,verified:rows.filter(r=>r.active&&r.status==='verified').length,
    symbolVerified:rows.filter(r=>r.active&&r.symbol_verified).length,chartReady:rows.filter(r=>r.active&&r.chart_ready).length};
}
function unchangedOutside(before,after) {
  const other=rows=>rows.filter(r=>!SYMBOLS.includes(r.symbol)).sort((a,b)=>a.symbol.localeCompare(b.symbol));
  return JSON.stringify(other(before))===JSON.stringify(other(after));
}
module.exports={SYMBOLS,RUN_KEY,selectCanary,counts,unchangedOutside};
