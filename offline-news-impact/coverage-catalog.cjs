'use strict';
// Read-only projection of Existing Coverage. No registry, import, sync or writes.
const {normalizeSymbol}=require('../lib/validation.js');
const {registryCompanyName}=require('../server/search-company-names.js');
const {fail}=require('./reader.cjs');
function checkedRows(rows){
  if(!Array.isArray(rows)||!rows.length||rows.length>1000||new Set(rows.map(x=>x?.symbol)).size!==rows.length)throw fail('COVERAGE_INCOMPLETE');
  if(rows.some(x=>x.snapshot_total!==undefined&&Number(x.snapshot_total)!==rows.length))throw fail('COVERAGE_INCOMPLETE');
  return rows;
}
function fromCoverage(identityRows,nameRows){
  checkedRows(identityRows);checkedRows(nameRows);
  const metadata=new Map(nameRows.map(row=>[row.symbol,row]));const items=[],excluded={};
  const reject=reason=>{excluded[reason]=(excluded[reason]||0)+1;};
  for(const row of identityRows){
    const symbol=normalizeSymbol(row.symbol);
    if(!symbol||symbol!==row.symbol||row.provider!=='Yahoo Finance'||row.provider_symbol!==symbol+'.BK'){reject('INVALID_IDENTITY_MAPPING');continue;}
    if(row.active!==true||['inactive','unsupported'].includes(row.status)){reject('INACTIVE_OR_UNSUPPORTED');continue;}
    if(row.symbol_verified!==true||!['verified','partial','temporary_failed'].includes(row.status)){reject('SYMBOL_NOT_VERIFIED');continue;}
    const meta=metadata.get(symbol);
    const name=meta&&meta.active===true&&meta.provider===row.provider&&meta.provider_symbol===row.provider_symbol&&!['inactive','unsupported'].includes(meta.status)?registryCompanyName(meta):null;
    items.push({symbol,name:name||symbol,aliases:name?[name]:[],source:name?meta.name_source:'existing public.security_coverage verified symbol',nameVerified:Boolean(name)});
  }
  if(!items.length)throw fail('CATALOG_UNAVAILABLE');
  return{items,evidence:{source:'Existing public.security_coverage via listCandidates/listSearchCandidates',sourceRows:identityRows.length,nameRows:nameRows.length,eligibleSymbols:items.length,englishNames:items.filter(x=>x.nameVerified).length,symbolOnly:items.filter(x=>!x.nameVerified).length,excluded,chartAndTechnicalRequired:false}};
}
function createCoverageCatalog(repository){
  if(typeof repository?.listSearchCandidates!=='function'||typeof repository?.listCandidates!=='function')throw fail('COVERAGE_REPOSITORY_REQUIRED');
  return async()=>{
    // Search's reviewed English-name projection does not include symbol_verified.
    // Read the existing identity projection too; neither path mutates coverage.
    let identities,names,nameRead='AVAILABLE';
    try{identities=await repository.listCandidates();}catch{throw fail('CATALOG_UNAVAILABLE');}
    try{names=await repository.listSearchCandidates();}catch{nameRead='UNAVAILABLE';names=identities.map(({symbol,provider,provider_symbol,active,status})=>({symbol,provider,provider_symbol,active,status}));}
    const result=fromCoverage(identities,names);result.evidence.englishNameRead=nameRead;return result;
  };
}
module.exports={fromCoverage,createCoverageCatalog};
