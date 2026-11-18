'use strict';
// Test-only identity/name pairs from existing reviewed Coverage. Never a runtime registry.
// Status, readiness, provenance and dates below are synthetic contract fixtures.
const pairs=require('./coverage-identities.json');
const {fromCoverage}=require('../coverage-catalog.cjs');
const rows=pairs.map(([symbol,name])=>({symbol,provider_symbol:symbol+'.BK',provider:'Yahoo Finance',active:true,status:symbol==='BANPU'?'partial':'verified',symbol_verified:symbol!=='ACAP',chart_ready:symbol!=='BANPU',technical_ready:symbol!=='BANPU',company_name_en:name,name_source:name?'https://coverage.fixture.invalid/company/'+encodeURIComponent(symbol):null,name_checked_at:name?'2000-01-01T00:00:00Z':null,snapshot_total:pairs.length}));
const snapshot={rows};
const repository={listCandidates:async()=>structuredClone(rows),listSearchCandidates:async()=>structuredClone(rows)};
const catalog=fromCoverage(rows,rows);
module.exports={catalog,repository,snapshot,loadCatalog:async()=>catalog};
