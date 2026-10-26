'use strict';
const fs=require('node:fs'),path=require('node:path');
const {parseSecCompanyNames,SEC_DIRECTORY}=require('../server/search-company-source');
// Manual, read-only acquisition. Output is an offline candidate file, never database writes.
// SEC Website Policy permits use/download without changing the meaning, subject to specific restrictions.
async function collect({registry,cacheDirectory,fetchImpl=globalThis.fetch,delayMs=750}){
 fs.mkdirSync(cacheDirectory,{recursive:true});const records=[],duplicates=[],checkedAt=new Date().toISOString();
 for(const letter of [...new Set(registry.map(r=>r.symbol[0]))].sort()){
  if(!/^[A-Z0-9]$/.test(letter))throw Error('Invalid directory partition');
  const filename=path.join(cacheDirectory,letter+'.html');let html;
  if(fs.existsSync(filename))html=fs.readFileSync(filename,'utf8');
  else{
   const response=await fetchImpl(SEC_DIRECTORY+letter,{signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw Error('SEC directory HTTP '+response.status+'; acquisition stopped without retry');
   html=await response.text();fs.writeFileSync(filename,html,{flag:'wx'});
   await new Promise(resolve=>setTimeout(resolve,delayMs));
  }
  // Cached pages retain their acquisition time instead of pretending they were fetched again.
  const parsed=parseSecCompanyNames(html,registry.filter(r=>r.symbol.startsWith(letter)),
   {checkedAt:new Date(Math.min(Date.parse(checkedAt),fs.statSync(filename).mtimeMs)).toISOString()});
  records.push(...parsed.records);duplicates.push(...parsed.duplicates);
 }
 return {records,duplicates,missing:registry.filter(r=>!records.some(n=>n.symbol===r.symbol)).map(r=>r.symbol)};
}
if(require.main===module)(async()=>{
 if(process.argv.length!==5)throw Error('Usage: node scripts/collect-search-company-names.js registry.json cache-directory output.json');
 const registry=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
 const result=await collect({registry,cacheDirectory:process.argv[3]});
 fs.writeFileSync(process.argv[4],JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({matched:result.records.length,requested:registry.length,missing:result.missing,duplicates:result.duplicates,productionWrites:0}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={collect};
