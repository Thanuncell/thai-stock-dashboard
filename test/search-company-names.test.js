'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createStockSearchService}=require('../server/search-service');
const {createCoverageRepository}=require('../server/coverage-service');
const {prepareCompanyNameImport,registryCompanyName}=require('../server/search-company-names');
const {parseSecCompanyNames}=require('../server/search-company-source');
const row=(symbol='AMATA',named=true)=>({symbol,provider_symbol:symbol+'.BK',provider:'Yahoo Finance',active:true,status:'verified',symbol_verified:true,chart_ready:true,
 ...(named?{company_name_en:'Amata Corporation Public Company Limited',name_source:'https://source.example/company/AMATA',name_checked_at:'2026-10-25T00:00:00Z'}:{})});
const record=()=>({...row(),identity_evidence:'https://source.example/identity/AMATA',rights_evidence:'https://source.example/permission',storage_allowed:true,display_allowed:true});

test('registry English name answers immediately without Yahoo and preserves coverage fields',async()=>{
 const rows=[Object.freeze(row())],before=structuredClone(rows);let calls=0;
 const search=createStockSearchService({registrySearch:async()=>rows,providerSearch:async()=>{calls++;throw Error('outage');}});
 assert.equal((await search.search('amata'))[0].name,row().company_name_en);assert.equal(calls,0);assert.deepEqual(rows,before);
});
test('mixed prefix keeps reviewed names authoritative over duplicate/contradictory Yahoo enrichment',async()=>{
 const rows=[row('THAI'),row('THANI',false)];rows[0].company_name_en='Thai Airways International Public Company Limited';
 const service=createStockSearchService({registrySearch:async()=>rows,providerSearch:async()=>[
  {symbol:'THAI',name:'Incorrect Yahoo Name'},{symbol:'THANI',name:'Ratchthani Leasing Public Company Limited'},
  {symbol:'THANI',name:'Duplicate'}]});
 const result=await service.search('tha');assert.deepEqual(result.map(r=>r.symbol),['THAI','THANI']);
 assert.equal(result[0].name,rows[0].company_name_en);assert.equal(result[1].name,'Ratchthani Leasing Public Company Limited');
 assert.equal((await service.search('thani'))[0].symbol,'THANI');
});
test('missing or unreviewed names stay symbol-only on timeout; never persist Yahoo',async()=>{
 for(const metadata of [{},{company_name_en:'Invented name'},{...row(),name_source:'https://finance.yahoo.com/quote/AMATA.BK'},
  {...row(),company_name_en:'บริษัท อมตะ'},{...row(),name_checked_at:'2999-01-01'}]){
  const rows=[{...row('AMATA',false),...metadata}],before=structuredClone(rows);let signal;
  const search=createStockSearchService({registrySearch:async()=>rows,enrichmentMs:10,providerSearch:async(q,options)=>{signal=options.signal;return new Promise(()=>{});}});
  assert.equal((await search.search('AMATA'))[0].name,'AMATA');assert.equal(signal.aborted,true);assert.deepEqual(rows,before);
 }
 const rows=[row('AMATA',false)];const search=createStockSearchService({registrySearch:async()=>rows,providerSearch:async()=>[{symbol:'AMATA',name:row().company_name_en}]});
 assert.equal((await search.search('AMATA'))[0].name,row().company_name_en);assert.equal(rows[0].company_name_en,undefined);
});
test('incorrect mappings and duplicate registry identities never contribute a company name',async()=>{
 for(const rows of [[{...row(),provider_symbol:'AMATAV.BK'}],[row(),{...row(),company_name_en:'Conflicting Company Limited'}]]){
  const search=createStockSearchService({registrySearch:async()=>rows,providerSearch:async()=>[]});assert.deepEqual(await search.search('AMATA'),[]);
 }
 assert.equal(registryCompanyName({...row(),name_source:'https://user:password@source.example'}),null);
});
test('500 named synthetic registry identities retain exact first ranking without enrichment or state changes',async t=>{
 const rows=Array.from({length:500},(_,i)=>({...row('S'+String(i).padStart(4,'0')),company_name_en:`Synthetic Company ${i} Public Company Limited`}));
 const before=structuredClone(rows);let calls=0;const search=createStockSearchService({registrySearch:async()=>rows,providerSearch:async()=>{calls++;return[];}});
 for(const r of rows){const result=await search.search(r.symbol.toLowerCase());assert.equal(result[0].symbol,r.symbol);assert.equal(result[0].name,r.company_name_en);}
 assert.equal(calls,0);assert.deepEqual(rows,before);t.diagnostic('Named exact match 500/500; provider requests 0');
});
test('search-only repository projection preserves legacy candidates and old-schema fallback',async()=>{
 const paths=[];let missing=false;
 const repo=createCoverageRepository({env:{SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SECRET_KEY:'synthetic-fixture'},fetchImpl:async(url,init)=>{
  assert.ok(!init.method||init.method==='GET');paths.push(new URL(url).searchParams.get('select'));
  if(missing&&paths.at(-1).includes('company_name_en'))return Response.json({code:'42703'},{status:400});
  return Response.json([row()]);
 }});
 await repo.listCandidates();assert.ok(!paths[0].includes('company_name_en'));
 assert.equal((await repo.listSearchCandidates())[0].company_name_en,row().company_name_en);assert.ok(paths[1].includes('name_source'));
 missing=true;assert.equal((await repo.listSearchCandidates())[0].symbol,'AMATA');assert.equal(paths.length,4);
});
test('search registry does not mask permissions or malformed bounded snapshots',async()=>{
 for(const response of [Response.json({code:'42501'},{status:403}),Response.json({code:'OTHER'},{status:400}),Response.json({}),
  Response.json([row()],{headers:{'content-range':'0-0/2'}})]){
  let calls=0;const repo=createCoverageRepository({env:{SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SECRET_KEY:'synthetic-fixture'},fetchImpl:async()=>{calls++;return response;}});
  await assert.rejects(repo.listSearchCandidates());assert.equal(calls,1);
 }
});
test('offline name preparation changes only name fields and produces guarded rollback',()=>{
 const registry=[row('AMATA',false),row('PTT',false)],before=structuredClone(registry),records=[record()];
 const plan=prepareCompanyNameImport({registry,records});assert.deepEqual(registry,before);assert.equal(plan.changes.length,1);
 assert.deepEqual(Object.keys(plan.changes[0].after),['company_name_en','name_source','name_checked_at']);
 assert.match(plan.sql,/IS NOT DISTINCT FROM/);assert.match(plan.rollbackSql,/company_name_en=NULL/);
 assert.doesNotMatch(plan.sql,/SET (status|symbol_verified|chart_ready|last_verified_at)=/);assert.ok(!plan.sql.includes("symbol='PTT'"));
});
test('offline import rejects duplicate, unknown, inactive, mismapped and unlicensed names atomically',()=>{
 const registry=[row('AMATA',false)];
 for(const records of [[record(),record()],[{...record(),symbol:'PTT'}],[{...record(),provider_symbol:'AMATAV.BK'}],
  [{...record(),storage_allowed:false}],[{...record(),display_allowed:false}],[{...record(),rights_evidence:null}],
  [{...record(),name_source:'https://finance.yahoo.com/quote/AMATA.BK'}],[{...record(),company_name_en:'<script>wrong</script>'}]]){
  assert.throws(()=>prepareCompanyNameImport({registry,records}));
 }
 assert.throws(()=>prepareCompanyNameImport({registry:[{...registry[0],active:false}],records:[record()]}));
 assert.throws(()=>prepareCompanyNameImport({registry:[...registry,...registry],records:[record()]}));
});
test('SEC parser binds ticker text to its official profile link and preserves full source name',()=>{
 const html='<tr><td>AMATA</td><td><a href="/public/idisc/en/companyprofile/listed/AMATA">AMATA CORPORATION PUBLIC COMPANY LIMITED</a></td></tr>';
 const parsed=parseSecCompanyNames(html,[row('AMATA',false)],{checkedAt:'2026-10-25T00:00:00Z'});
 assert.equal(parsed.records[0].company_name_en,'AMATA CORPORATION PUBLIC COMPANY LIMITED');
 assert.match(parsed.records[0].identity_evidence,/listed\/AMATA$/);assert.match(parsed.records[0].rights_evidence,/WebsitePolicy/);
 assert.equal(prepareCompanyNameImport({registry:[row('AMATA',false)],records:parsed.records}).changes.length,1);
 assert.equal(parseSecCompanyNames(html.replace('listed/AMATA','listed/AMATAV'),[row('AMATA',false)]).records.length,0);
 const duplicate=parseSecCompanyNames(html+html,[row('AMATA',false)]);assert.deepEqual(duplicate.duplicates,['AMATA']);assert.equal(duplicate.records.length,0);
 const entity=html.replaceAll('AMATA','L&amp;E').replace('AMATA CORPORATION','L&amp;E CORPORATION');
 assert.equal(parseSecCompanyNames(entity,[row('L&E',false)]).records[0].symbol,'L&E');
 assert.equal(parseSecCompanyNames(entity.replace('listed/L&amp;E','listed/Lx26E'),[row('L&E',false)]).records[0].symbol,'L&E');
});
test('SEC manual acquisition stops on 403/429/503 without retry or database side effects',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{collect}=require('../scripts/collect-search-company-names');
 for(const status of [403,429,503]){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'setscope-name-fixture-'));let calls=0;
  try{await assert.rejects(collect({registry:[row()],cacheDirectory:directory,delayMs:0,fetchImpl:async()=>{calls++;return Response.json({},{status});}}),new RegExp('HTTP '+status));assert.equal(calls,1);assert.deepEqual(fs.readdirSync(directory),[]);}
  finally{fs.rmSync(directory,{recursive:true,force:true});}
 }
});
