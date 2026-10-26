'use strict';
const {englishCompanyName}=require('./search-company-names');
const SEC_DIRECTORY='https://market.sec.or.th/public/idisc/en/company/listed/';
const SEC_POLICY='https://www.sec.or.th/TH/Pages/Footer/WebsitePolicy.aspx';
function decodeText(value){return value.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&nbsp;/g,' ')
 .replace(/&#(x[\da-f]+|\d+);/gi,(_,n)=>String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n))).trim();}
function parseSecCompanyNames(html,registry,{checkedAt=new Date().toISOString()}={}){
 const records=[],duplicates=new Set(),found=new Map();
 const pattern=/<tr[^>]*>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>\s*<a[^>]*href="([^"]*companyprofile\/listed\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
 for(const match of html.matchAll(pattern)){
  const symbol=decodeText(match[1]),url=new URL(decodeText(match[2]),SEC_DIRECTORY),name=decodeText(match[3]);
  const profile='/public/idisc/en/companyprofile/listed/';
  if(url.origin!=='https://market.sec.or.th'||![profile+symbol,profile+symbol.replaceAll('&','x26')].includes(decodeURIComponent(url.pathname))||!englishCompanyName(name))continue;
  if(found.has(symbol))duplicates.add(symbol);found.set(symbol,{name,url:url.href});
 }
 for(const row of registry){
  const source=found.get(row.symbol);if(!source||duplicates.has(row.symbol))continue;
  if(row.provider!=='Yahoo Finance'||row.provider_symbol!==row.symbol+'.BK'||row.active!==true)throw Error('Registry mapping requires review');
  records.push({symbol:row.symbol,provider_symbol:row.provider_symbol,company_name_en:source.name,name_source:SEC_DIRECTORY+row.symbol[0],
   name_checked_at:checkedAt,identity_evidence:source.url,rights_evidence:SEC_POLICY,storage_allowed:true,display_allowed:true});
 }
 return {records,duplicates:[...duplicates].filter(symbol=>registry.some(row=>row.symbol===symbol))};
}
module.exports={parseSecCompanyNames,SEC_DIRECTORY,SEC_POLICY};
