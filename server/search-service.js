'use strict';
const {normalizeSymbol}=require('../lib/validation');
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
function createStockSearchService({providerSearch,registrySearch=async()=>[]}={}){
 return {async search(query){
  const q=String(query||'').trim().toUpperCase().replace(/\.BK$/,'');
  let registry=[];
  if(/^[A-Z0-9&.-]{1,20}$/.test(q)){
   try{registry=(await registrySearch()).filter(r=>r.active===true&&!['inactive','unsupported'].includes(r.status)
    &&r.provider==='Yahoo Finance'&&r.provider_symbol===r.symbol+'.BK'&&r.symbol.startsWith(q))
    .map(r=>({symbol:r.symbol,name:r.symbol,exchange:'หุ้นไทย',type:'EQUITY'}));}catch{/* Search can still use the independent provider. */}
  }
  let provided=[];
  try{provided=await providerSearch(query,{allowSuffixFallback:registry.length===0});}
  catch(error){if(!registry.length)throw error;}
  return rankStockSearchResults(query,[...provided,...registry]);
 }};
}
module.exports={createStockSearchService,rankStockSearchResults};
