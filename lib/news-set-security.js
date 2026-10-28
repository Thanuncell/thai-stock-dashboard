'use strict';
const {normalizeSymbol}=require('./validation');
const {canonicalUrl}=require('./news-evidence');
const {marketHtmlText}=require('./settrade-parser');
const {registryCompanyName}=require('../server/search-company-names');
const {stockAliases,matchesWatchlistStock}=require('./watchlist-news-identity');
const {isSetNewsCandidate}=require('./news-content');
const official=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&/(?:^|\.)(?:set\.or\.th|settrade\.com)$/.test(u.hostname);}catch{return false;}};
const normal=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const companyKey=value=>normal(String(value||'').replace(/^\s*บริษัท\s*/,'').replace(/\s*จำกัด\s*(?:\(\s*มหาชน\s*\)|มหาชน)?\s*$/,''));
function identifySetSecurities(item,{url,html='',text=''}={},registry=[]){
 if(!isSetNewsCandidate(item))return null;
 const empty=reason=>({status:'UNVERIFIED',symbols:[],reason});
 if(!official(url))return empty('SET_PUBLISHER_UNVERIFIED');
 const key=canonicalUrl(url);
 const canonicals=[...html.matchAll(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>|<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["'][^>]*>/gi)];
 if(canonicals.some(m=>canonicalUrl(m[1]||m[2])!==key))return empty('ISSUER_IDENTITY_UNBOUND');
 const counts=new Map();for(const row of registry)counts.set(row.symbol,(counts.get(row.symbol)||0)+1);
 const rows=registry.filter(r=>r.symbol===normalizeSymbol(r.symbol)&&counts.get(r.symbol)===1&&r.active===true&&r.provider==='Yahoo Finance'&&r.provider_symbol===r.symbol+'.BK'&&!['inactive','unsupported'].includes(r.status));
 if(!rows.length)return empty('SECURITY_MASTER_UNAVAILABLE');
 const bySymbol=new Map(rows.map(r=>[r.symbol,r])),found=new Set();let conflict=false,bound=false;
 const names=r=>[registryCompanyName(r),...stockAliases({symbol:r.symbol})].filter(Boolean);
 for(const script of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
  try{const queue=[JSON.parse(script[1])];for(let n=0;queue.length&&n<1000;n++){
   const record=queue.shift();if(!record||typeof record!=='object')continue;
   const types=[record['@type']].flat();
   const identity=[record.url,typeof record.mainEntityOfPage==='string'?record.mainEntityOfPage:record.mainEntityOfPage?.['@id']].filter(x=>typeof x==='string');
   const headline=normal(record.headline||record.name),wanted=normal(String(item.title||'').replace(/\s+-\s+[^-]+$/,''));
   if(types.some(t=>['Article','NewsArticle','ReportageNewsArticle','AnalysisNewsArticle'].includes(t))&&identity.length&&identity.every(x=>canonicalUrl(x)===key)&&headline&&wanted&&(headline===wanted||headline.includes(wanted))){
    bound=true;
    for(const company of [record.about,record.mentions].flat().filter(Boolean).slice(0,30)){
     if(typeof company!=='object'||![company['@type']].flat().some(t=>['Corporation','Organization'].includes(t)))continue;
     const ticker=String(company.tickerSymbol||'').trim().match(/^(?:(?:SET|XBKK)[:\s]+)?([A-Z0-9][A-Z0-9&.-]{0,19})$/)?.[1];
     const name=company.legalName||company.name;
     const nameRows=name?rows.filter(r=>names(r).some(x=>companyKey(x)===companyKey(name))):[];
     if(ticker&&bySymbol.has(ticker)){
      if(name&&(!nameRows.some(r=>r.symbol===ticker)||nameRows.length!==1)){conflict=true;continue;}found.add(ticker);
     }else if(nameRows.length===1)found.add(nameRows[0].symbol);
     else if(nameRows.length>1)conflict=true;
    }
   }
   queue.push(...Object.values(record).filter(x=>x&&typeof x==='object'));
  }}catch{/* Malformed or unrelated JSON cannot establish an issuer. */}
 }
 // SET news-detail labels can identify an issuer independently of Article verification.
 // Require the same page canonical and headline, and restrict labels to a single article/main.
 const sections=[...html.matchAll(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
 if(canonicals.length&&sections.length===1){
  const scoped=sections[0][2].replace(/<(script|style|nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi,' ');
  const headings=[...scoped.matchAll(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/gi)].map(m=>normal(marketHtmlText(m[1])));
  const wanted=normal(String(item.title||'').replace(/\s+-\s+[^-]+$/,''));
  if(wanted&&headings.filter(h=>h===wanted).length===1){
   const visible=marketHtmlText(scoped),labels=[...visible.matchAll(/(?:หลักทรัพย์|Security(?: Symbol)?)\s*[:：]?\s+([A-Z0-9&.,\s-]{1,80}?)\s+(?:แหล่งข่าว|Source)\s*[:：]?\s+([A-Z0-9&.,\s-]{1,80}?)(?=\s+(?:รายละเอียด|Detail|วันที่|Date)|$)/g)];
   if(labels.length===1){
    const securities=labels[0][1].trim().split(/[,\s]+/),issuers=labels[0][2].trim().split(/[,\s]+/);
    if(securities.every(x=>bySymbol.has(x))&&securities.length<=10&&securities.every(x=>issuers.includes(x))){bound=true;for(const symbol of securities)found.add(symbol);}
   }
  }
 }
 // Text supplied here comes only from an article inspection, never an RSS snippet/footer.
 if(text){bound=true;for(const row of rows){
  const aliases=names(row);
  if(aliases.some(name=>normal(name).length>=8&&normal(text).includes(normal(name)))||new RegExp('(?:หุ้น|หลักทรัพย์|symbol|ticker)\\s*[:：]?\\s*'+row.symbol.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![A-Za-z0-9])','i').test(text)){
   if(matchesWatchlistStock({symbol:row.symbol,verifiedName:registryCompanyName(row)},text))found.add(row.symbol);
  }
 }}
 if(conflict)return empty('ISSUER_IDENTITY_CONFLICT');
 return {status:found.size?'IDENTIFIED':'UNVERIFIED',symbols:[...found].sort().slice(0,10),reason:found.size?'OFFICIAL_ISSUER_MATCH':bound?'ISSUER_NOT_IDENTIFIED':'ISSUER_IDENTITY_UNBOUND',publisherUrl:url};
}
module.exports={identifySetSecurities,officialSetUrl:official};
