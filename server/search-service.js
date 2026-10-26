'use strict';
const {normalizeSymbol}=require('../lib/validation');
const SEARCH_ENRICHMENT_MS=750;
function rankStockSearchResults(query,items){
 const q=String(query||'').trim().toUpperCase().replace(/\.BK$/,'');
 const unique=new Map();
 for(const item of items){
  const symbol=normalizeSymbol(item?.symbol);
  if(!symbol)continue;
  const value={...item,symbol,name:String(item.name||symbol).slice(0,200)};
  if(!unique.has(symbol)||unique.get(symbol).name===symbol)unique.set(symbol,value);
 }
 const score=item=>item.symbol===q?0:item.symbol.startsWith(q)?1:item.symbol.includes(q)?2:item.name.toUpperCase().includes(q)?3:4;
 return [...unique.values()].sort((a,b)=>score(a)-score(b)||a.symbol.length-b.symbol.length||a.symbol.localeCompare(b.symbol)).slice(0,12);
}
function createStockSearchService({providerSearch,registrySearch=async()=>[],enrichmentMs=SEARCH_ENRICHMENT_MS}={}){
 if(!Number.isInteger(enrichmentMs)||enrichmentMs<1||enrichmentMs>SEARCH_ENRICHMENT_MS)throw Error('Invalid search enrichment deadline');
 return {async search(query){
  const q=String(query||'').trim().toUpperCase().replace(/\.BK$/,'');
  let registry=[];
  if(/^[A-Z0-9&.-]{1,20}$/.test(q)){
   try{registry=(await registrySearch()).filter(r=>r.active===true&&!['inactive','unsupported'].includes(r.status)
    &&r.provider==='Yahoo Finance'&&r.provider_symbol===r.symbol+'.BK'&&r.symbol.startsWith(q))
    .map(r=>({symbol:r.symbol,name:r.symbol,exchange:'หุ้นไทย',type:'EQUITY'}));}catch{/* Search can still use the independent provider. */}
  }
  let provided=[];
  let timer;
  try{
   if(registry.length){
    const controller=new AbortController();
    const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{
     const error=Object.assign(Error('Search enrichment timed out'),{code:'SEARCH_ENRICHMENT_TIMEOUT'});controller.abort(error);reject(error);
    },enrichmentMs);});
    // Race the complete search (including body reads): an uncooperative fetch must not hold registry results.
    provided=await Promise.race([Promise.resolve().then(()=>providerSearch(query,{allowSuffixFallback:false,signal:controller.signal})),expired]);
   }else provided=await providerSearch(query,{allowSuffixFallback:true});
  }
  catch(error){if(!registry.length)throw error;}
  finally{clearTimeout(timer);}
  return rankStockSearchResults(query,[...provided,...registry]);
 }};
}
module.exports={createStockSearchService,rankStockSearchResults,SEARCH_ENRICHMENT_MS};
